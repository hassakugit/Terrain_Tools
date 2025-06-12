const express = require('express');
const cors = require('cors');
const axios = require('axios');
const path = require('path');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 2021;
const GOOGLE_MAPS_API_KEY = process.env.GOOGLE_MAPS_API_KEY;

// Middleware
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.static('public'));

// Enhanced rate limiting for API calls
const requestCounts = new Map();
const RATE_LIMIT_WINDOW = 60000; // 1 minute
const MAX_REQUESTS_PER_WINDOW = 5; // Reduced to be more conservative

// Track ongoing elevation requests to prevent duplicates
const activeRequests = new Map();

function rateLimit(req, res, next) {
    const clientIP = req.ip || req.connection.remoteAddress;
    const now = Date.now();
    
    if (!requestCounts.has(clientIP)) {
        requestCounts.set(clientIP, { count: 1, resetTime: now + RATE_LIMIT_WINDOW });
        return next();
    }
    
    const clientData = requestCounts.get(clientIP);
    
    if (now > clientData.resetTime) {
        clientData.count = 1;
        clientData.resetTime = now + RATE_LIMIT_WINDOW;
        return next();
    }
    
    if (clientData.count >= MAX_REQUESTS_PER_WINDOW) {
        return res.status(429).json({ 
            error: 'Too many requests. Please wait before trying again.' 
        });
    }
    
    clientData.count++;
    next();
}

// Utility function to delay execution
function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// Enhanced elevation data fetching with progressive batching
async function fetchElevationDataWithRetry(locations, apiKey, progressCallback) {
    const elevationData = [];
    const batchSize = 100; // Smaller batch size to be more conservative
    const delayBetweenBatches = 100; // 100ms delay between batches
    const maxRetries = 3;
    
    const totalBatches = Math.ceil(locations.length / batchSize);
    console.log(`Processing ${locations.length} locations in ${totalBatches} batches`);
    
    for (let i = 0; i < locations.length; i += batchSize) {
        const batchIndex = Math.floor(i / batchSize) + 1;
        const batch = locations.slice(i, i + batchSize);
        
        console.log(`Processing batch ${batchIndex}/${totalBatches} (${batch.length} points)`);
        
        // Report progress
        if (progressCallback) {
            progressCallback({
                batch: batchIndex,
                totalBatches,
                progress: Math.round((batchIndex / totalBatches) * 100)
            });
        }
        
        let retryCount = 0;
        let batchSuccess = false;
        
        while (!batchSuccess && retryCount < maxRetries) {
            try {
                const locationString = batch.map(loc => `${loc.lat.toFixed(6)},${loc.lng.toFixed(6)}`).join('|');
                
                const response = await axios.get('https://maps.googleapis.com/maps/api/elevation/json', {
                    params: {
                        locations: locationString,
                        key: apiKey
                    },
                    timeout: 15000, // Reduced timeout
                    headers: {
                        'User-Agent': 'TerrainGenerator/1.0'
                    }
                });

                if (response.data.status === 'OK') {
                    elevationData.push(...response.data.results);
                    batchSuccess = true;
                    console.log(`Batch ${batchIndex} completed successfully`);
                } else if (response.data.status === 'REQUEST_DENIED') {
                    throw new Error('API key is invalid or APIs not enabled');
                } else if (response.data.status === 'OVER_DAILY_LIMIT') {
                    throw new Error('API daily limit exceeded');
                } else if (response.data.status === 'OVER_QUERY_LIMIT') {
                    // Wait longer and retry for rate limit issues
                    console.log(`Rate limit hit on batch ${batchIndex}, waiting before retry...`);
                    await delay(2000 * (retryCount + 1)); // Exponential backoff
                    retryCount++;
                    if (retryCount >= maxRetries) {
                        throw new Error('API query limit exceeded - please try again later');
                    }
                } else if (response.data.status === 'INVALID_REQUEST') {
                    throw new Error('Invalid request - check your selection area');
                } else {
                    throw new Error(`Elevation API error: ${response.data.status} - ${response.data.error_message || 'Unknown error'}`);
                }
            } catch (axiosError) {
                retryCount++;
                console.error(`Batch ${batchIndex} attempt ${retryCount} failed:`, axiosError.message);
                
                if (axiosError.code === 'ECONNABORTED') {
                    console.log(`Timeout on batch ${batchIndex}, retrying...`);
                } else if (axiosError.response && axiosError.response.status === 400) {
                    // 400 errors are often due to too many points or invalid coordinates
                    throw new Error('Bad request - try selecting a smaller area or lower resolution');
                } else if (retryCount >= maxRetries) {
                    throw axiosError;
                }
                
                // Wait before retry
                await delay(1000 * retryCount);
            }
        }
        
        // Small delay between successful batches to be respectful to the API
        if (batchIndex < totalBatches) {
            await delay(delayBetweenBatches);
        }
    }
    
    return elevationData;
}

// Serve the main HTML file
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Health check endpoint
app.get('/health', (req, res) => {
    res.json({ 
        status: 'healthy', 
        timestamp: new Date().toISOString(),
        uptime: process.uptime()
    });
});

// Endpoint to provide API key to frontend (if server has one)
app.get('/api/config', (req, res) => {
    res.json({
        googleMapsApiKey: GOOGLE_MAPS_API_KEY || null,
        serverConfigured: !!GOOGLE_MAPS_API_KEY
    });
});

// Enhanced elevation endpoint with better error handling and progress tracking
app.post('/api/elevation', rateLimit, async (req, res) => {
    const startTime = Date.now();
    const requestId = Date.now().toString();
    
    try {
        const { bounds, resolution, apiKey } = req.body;
        
        // Use API key from request first, fallback to server environment variable
        const finalApiKey = apiKey || GOOGLE_MAPS_API_KEY;
        
        // Validation
        if (!finalApiKey) {
            return res.status(400).json({ error: 'Google Maps API key is required' });
        }
        
        if (!bounds || !bounds.north || !bounds.south || !bounds.east || !bounds.west) {
            return res.status(400).json({ error: 'Invalid bounds provided' });
        }
        
        if (!resolution || resolution < 10 || resolution > 300) { // Reduced max resolution
            return res.status(400).json({ error: 'Resolution must be between 10 and 300' });
        }
        
        // Check bounds validity
        if (bounds.north <= bounds.south || bounds.east <= bounds.west) {
            return res.status(400).json({ error: 'Invalid bounds: north must be > south, east must be > west' });
        }
        
        // Calculate area to prevent abuse
        const latDiff = Math.abs(bounds.north - bounds.south);
        const lngDiff = Math.abs(bounds.east - bounds.west);
        const area = latDiff * lngDiff;
        
        // More restrictive area limits based on resolution
        const maxArea = resolution > 200 ? 0.1 : resolution > 100 ? 0.5 : 1.0;
        if (area > maxArea) {
            return res.status(400).json({ 
                error: `Selected area is too large for this resolution. Maximum area: ${maxArea} square degrees. Try selecting a smaller area or lower resolution.` 
            });
        }

        // Check if similar request is already in progress
        const requestKey = `${bounds.north}-${bounds.south}-${bounds.east}-${bounds.west}-${resolution}`;
        if (activeRequests.has(requestKey)) {
            return res.status(409).json({ 
                error: 'A similar request is already being processed. Please wait.' 
            });
        }

        activeRequests.set(requestKey, requestId);

        console.log(`[${requestId}] Processing elevation request: ${resolution}x${resolution} grid, area: ${area.toFixed(6)}`);

        // Calculate grid points based on resolution
        const latStep = (bounds.north - bounds.south) / resolution;
        const lngStep = (bounds.east - bounds.west) / resolution;
        
        const locations = [];
        for (let i = 0; i <= resolution; i++) {
            for (let j = 0; j <= resolution; j++) {
                const lat = bounds.south + (i * latStep);
                const lng = bounds.west + (j * lngStep);
                
                // Validate coordinates
                if (lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180) {
                    locations.push({ lat, lng });
                }
            }
        }

        if (locations.length === 0) {
            throw new Error('No valid coordinates in the selected area');
        }

        console.log(`[${requestId}] Generated ${locations.length} elevation points`);

        // Use the enhanced fetching function
        const elevationData = await fetchElevationDataWithRetry(
            locations, 
            finalApiKey,
            (progress) => {
                console.log(`[${requestId}] Progress: ${progress.progress}% (batch ${progress.batch}/${progress.totalBatches})`);
            }
        );

        const processingTime = Date.now() - startTime;
        console.log(`[${requestId}] Elevation data processed in ${processingTime}ms`);

        // Validate we got all the data we expected
        if (elevationData.length !== locations.length) {
            console.warn(`[${requestId}] Expected ${locations.length} elevation points but got ${elevationData.length}`);
            
            // If we're missing too much data, fail the request
            const missingPercent = ((locations.length - elevationData.length) / locations.length) * 100;
            if (missingPercent > 10) {
                throw new Error(`Too much elevation data missing (${missingPercent.toFixed(1)}%). Please try again with a smaller area.`);
            }
        }

        res.json({
            elevationData,
            bounds,
            resolution,
            metadata: {
                points: elevationData.length,
                expectedPoints: locations.length,
                processingTime,
                area: area.toFixed(6),
                requestId
            }
        });
        
    } catch (error) {
        console.error(`[${requestId}] Error fetching elevation data:`, error);
        
        let errorMessage = 'Failed to fetch elevation data';
        let statusCode = 500;
        
        if (error.message.includes('API key')) {
            statusCode = 401;
            errorMessage = error.message;
        } else if (error.message.includes('limit') || error.message.includes('quota')) {
            statusCode = 429;
            errorMessage = error.message + '. Please wait a few minutes before trying again.';
        } else if (error.message.includes('timeout')) {
            statusCode = 408;
            errorMessage = 'Request timeout - please try with a smaller area or lower resolution';
        } else if (error.message.includes('Bad request') || error.message.includes('Invalid request')) {
            statusCode = 400;
            errorMessage = error.message;
        } else if (error.response && error.response.status) {
            statusCode = error.response.status;
            errorMessage = `External API error: ${error.message}`;
        } else {
            errorMessage = error.message;
        }
        
        res.status(statusCode).json({ 
            error: errorMessage,
            timestamp: new Date().toISOString(),
            requestId
        });
    } finally {
        // Clean up active request tracking
        const requestKey = `${req.body.bounds?.north}-${req.body.bounds?.south}-${req.body.bounds?.east}-${req.body.bounds?.west}-${req.body.resolution}`;
        activeRequests.delete(requestKey);
    }
});

// Error handling middleware
app.use((error, req, res, next) => {
    console.error('Unhandled error:', error);
    res.status(500).json({ 
        error: 'Internal server error',
        timestamp: new Date().toISOString()
    });
});

// 404 handler
app.use((req, res) => {
    res.status(404).json({ 
        error: 'Not found',
        path: req.path
    });
});

// Graceful shutdown
process.on('SIGTERM', () => {
    console.log('SIGTERM received, shutting down gracefully');
    process.exit(0);
});

process.on('SIGINT', () => {
    console.log('SIGINT received, shutting down gracefully');
    process.exit(0);
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`🏔️  3D Terrain Generator server running on port ${PORT}`);
    console.log(`📱 Access the application at: http://localhost:${PORT}`);
    console.log(`🔧 Health check available at: http://localhost:${PORT}/health`);
});
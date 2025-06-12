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

// Enhanced rate limiting for high-volume requests
const requestCounts = new Map();
const RATE_LIMIT_WINDOW = 60000; // 1 minute
const MAX_REQUESTS_PER_WINDOW = 3; // Very conservative for high-res requests

// Track ongoing elevation requests with detailed progress
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
            error: 'Too many high-resolution requests. Please wait before trying again.' 
        });
    }
    
    clientData.count++;
    next();
}

// Utility functions
function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function calculateOptimalBatchSize(totalPoints, apiLimitsPerSecond = 10) {
    // Dynamic batch sizing based on total points and API limits
    if (totalPoints > 100000) return 50;   // Ultra high-res: very small batches
    if (totalPoints > 50000) return 75;    // High-res: small batches
    if (totalPoints > 10000) return 100;   // Medium-res: moderate batches
    return 150; // Low-res: larger batches
}

function calculateOptimalDelay(batchSize, totalBatches) {
    // Adaptive delay based on batch size and total workload
    if (totalBatches > 1000) return 200;   // Very large jobs: longer delays
    if (totalBatches > 500) return 150;    // Large jobs: moderate delays
    if (totalBatches > 100) return 100;    // Medium jobs: short delays
    return 50; // Small jobs: minimal delays
}

// Advanced elevation fetching with intelligent batching and progress tracking
async function fetchElevationDataAdvanced(locations, apiKey, progressCallback, requestId) {
    const elevationData = [];
    const totalPoints = locations.length;
    
    // Calculate optimal batch parameters
    const batchSize = calculateOptimalBatchSize(totalPoints);
    const totalBatches = Math.ceil(totalPoints / batchSize);
    const delayBetweenBatches = calculateOptimalDelay(batchSize, totalBatches);
    
    console.log(`[${requestId}] Processing ${totalPoints} points in ${totalBatches} batches (${batchSize} points/batch, ${delayBetweenBatches}ms delay)`);
    
    const maxRetries = 5; // Increased retries for large datasets
    let successfulBatches = 0;
    let failedBatches = 0;
    
    // Process in smaller sub-chunks to handle very large datasets
    const superBatchSize = 50; // Process 50 batches at a time before longer pause
    const superBatches = Math.ceil(totalBatches / superBatchSize);
    
    for (let superBatch = 0; superBatch < superBatches; superBatch++) {
        const startBatch = superBatch * superBatchSize;
        const endBatch = Math.min(startBatch + superBatchSize, totalBatches);
        
        console.log(`[${requestId}] Processing super-batch ${superBatch + 1}/${superBatches} (batches ${startBatch + 1}-${endBatch})`);
        
        for (let batchIndex = startBatch; batchIndex < endBatch; batchIndex++) {
            const startIdx = batchIndex * batchSize;
            const endIdx = Math.min(startIdx + batchSize, totalPoints);
            const batch = locations.slice(startIdx, endIdx);
            
            // Report progress
            const overallProgress = Math.round(((batchIndex + 1) / totalBatches) * 100);
            if (progressCallback) {
                progressCallback({
                    batch: batchIndex + 1,
                    totalBatches,
                    progress: overallProgress,
                    phase: 'elevation',
                    pointsProcessed: startIdx,
                    totalPoints,
                    successfulBatches,
                    failedBatches
                });
            }
            
            let retryCount = 0;
            let batchSuccess = false;
            
            while (!batchSuccess && retryCount < maxRetries) {
                try {
                    // High precision coordinate formatting
                    const locationString = batch.map(loc => 
                        `${loc.lat.toFixed(8)},${loc.lng.toFixed(8)}`
                    ).join('|');
                    
                    const response = await axios.get('https://maps.googleapis.com/maps/api/elevation/json', {
                        params: {
                            locations: locationString,
                            key: apiKey
                        },
                        timeout: 30000, // Longer timeout for large requests
                        headers: {
                            'User-Agent': 'TerrainGenerator/2.0-HighRes'
                        }
                    });

                    if (response.data.status === 'OK') {
                        elevationData.push(...response.data.results);
                        batchSuccess = true;
                        successfulBatches++;
                        
                        if (batchIndex % 10 === 0) { // Log every 10 batches
                            console.log(`[${requestId}] Batch ${batchIndex + 1}/${totalBatches} completed (${overallProgress}%)`);
                        }
                    } else if (response.data.status === 'REQUEST_DENIED') {
                        throw new Error('API key is invalid or APIs not enabled');
                    } else if (response.data.status === 'OVER_DAILY_LIMIT') {
                        throw new Error('API daily limit exceeded');
                    } else if (response.data.status === 'OVER_QUERY_LIMIT') {
                        console.log(`[${requestId}] Rate limit on batch ${batchIndex + 1}, retry ${retryCount + 1}/${maxRetries}`);
                        const waitTime = Math.min(5000 * Math.pow(2, retryCount), 30000); // Exponential backoff, max 30s
                        await delay(waitTime);
                        retryCount++;
                        if (retryCount >= maxRetries) {
                            throw new Error('API rate limit exceeded - dataset too large for current quota');
                        }
                    } else if (response.data.status === 'INVALID_REQUEST') {
                        throw new Error('Invalid request - coordinates may be out of bounds');
                    } else {
                        throw new Error(`Elevation API error: ${response.data.status} - ${response.data.error_message || 'Unknown error'}`);
                    }
                } catch (axiosError) {
                    retryCount++;
                    console.error(`[${requestId}] Batch ${batchIndex + 1} attempt ${retryCount} failed:`, axiosError.message);
                    
                    if (axiosError.code === 'ECONNABORTED') {
                        console.log(`[${requestId}] Timeout on batch ${batchIndex + 1}, retrying...`);
                    } else if (axiosError.response && axiosError.response.status === 400) {
                        console.warn(`[${requestId}] Bad request on batch ${batchIndex + 1}, skipping...`);
                        // For high-res processing, we might skip problematic batches rather than fail entirely
                        batchSuccess = true; // Mark as "success" to continue
                        failedBatches++;
                        break;
                    } else if (retryCount >= maxRetries) {
                        failedBatches++;
                        throw new Error(`Batch ${batchIndex + 1} failed after ${maxRetries} retries: ${axiosError.message}`);
                    }
                    
                    // Progressive delay on retries
                    const retryDelay = Math.min(1000 * Math.pow(2, retryCount), 10000);
                    await delay(retryDelay);
                }
            }
            
            // Adaptive delay between batches
            if (batchIndex < totalBatches - 1) {
                await delay(delayBetweenBatches);
            }
        }
        
        // Longer pause between super-batches for very large datasets
        if (superBatch < superBatches - 1 && superBatches > 1) {
            console.log(`[${requestId}] Pausing 2s between super-batches...`);
            await delay(2000);
        }
    }
    
    console.log(`[${requestId}] Elevation fetching completed: ${successfulBatches} successful, ${failedBatches} failed batches`);
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
        uptime: process.uptime(),
        activeRequests: activeRequests.size
    });
});

// Endpoint to get progress of ongoing requests
app.get('/api/progress/:requestId', (req, res) => {
    const requestId = req.params.requestId;
    const progress = activeRequests.get(requestId);
    
    if (progress) {
        res.json(progress);
    } else {
        res.status(404).json({ error: 'Request not found or completed' });
    }
});

// Enhanced elevation endpoint for high-resolution processing
app.post('/api/elevation', rateLimit, async (req, res) => {
    const startTime = Date.now();
    const requestId = `req_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    
    try {
        const { bounds, resolution, apiKey } = req.body;
        
        // Use API key from request first, fallback to server environment variable
        const finalApiKey = apiKey || GOOGLE_MAPS_API_KEY;
        
        // Validation with much higher limits
        if (!finalApiKey) {
            return res.status(400).json({ error: 'Google Maps API key is required' });
        }
        
        if (!bounds || !bounds.north || !bounds.south || !bounds.east || !bounds.west) {
            return res.status(400).json({ error: 'Invalid bounds provided' });
        }
        
        // Much higher resolution limits - up to 2000x2000 grid
        if (!resolution || resolution < 10 || resolution > 2000) {
            return res.status(400).json({ error: 'Resolution must be between 10 and 2000' });
        }
        
        // Check bounds validity
        if (bounds.north <= bounds.south || bounds.east <= bounds.west) {
            return res.status(400).json({ error: 'Invalid bounds: north must be > south, east must be > west' });
        }
        
        // Calculate area - much more permissive limits
        const latDiff = Math.abs(bounds.north - bounds.south);
        const lngDiff = Math.abs(bounds.east - bounds.west);
        const area = latDiff * lngDiff;
        
        // Dynamic area limits based on resolution (more permissive)
        let maxArea;
        if (resolution > 1500) maxArea = 0.1;      // Ultra high-res: small areas
        else if (resolution > 1000) maxArea = 0.5;  // Very high-res: moderate areas
        else if (resolution > 500) maxArea = 2.0;   // High-res: large areas
        else maxArea = 10.0;                        // Lower-res: very large areas
        
        if (area > maxArea) {
            return res.status(400).json({ 
                error: `Selected area is too large for this resolution. Maximum area: ${maxArea} square degrees. Current area: ${area.toFixed(6)} square degrees.` 
            });
        }

        // Check if similar request is already in progress
        const requestKey = `${bounds.north}-${bounds.south}-${bounds.east}-${bounds.west}-${resolution}`;
        const existingRequest = Array.from(activeRequests.values()).find(req => req.key === requestKey);
        if (existingRequest) {
            return res.status(409).json({ 
                error: 'A similar request is already being processed.',
                requestId: existingRequest.id
            });
        }

        // Initialize request tracking
        activeRequests.set(requestId, {
            id: requestId,
            key: requestKey,
            startTime,
            status: 'initializing',
            progress: 0,
            phase: 'setup',
            bounds,
            resolution,
            area: area.toFixed(6)
        });

        console.log(`[${requestId}] Starting high-resolution processing: ${resolution}x${resolution} grid, area: ${area.toFixed(6)} sq degrees`);

        // Calculate grid points with high precision
        const latStep = (bounds.north - bounds.south) / resolution;
        const lngStep = (bounds.east - bounds.west) / resolution;
        
        const locations = [];
        for (let i = 0; i <= resolution; i++) {
            for (let j = 0; j <= resolution; j++) {
                const lat = bounds.south + (i * latStep);
                const lng = bounds.west + (j * lngStep);
                
                // Validate coordinates with high precision
                if (lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180) {
                    locations.push({ lat, lng });
                }
            }
        }

        if (locations.length === 0) {
            throw new Error('No valid coordinates in the selected area');
        }

        // Update progress
        activeRequests.set(requestId, {
            ...activeRequests.get(requestId),
            status: 'fetching_elevation',
            totalPoints: locations.length,
            estimatedBatches: Math.ceil(locations.length / calculateOptimalBatchSize(locations.length))
        });

        console.log(`[${requestId}] Generated ${locations.length} elevation points`);

        // Use the advanced fetching function with progress callback
        const elevationData = await fetchElevationDataAdvanced(
            locations, 
            finalApiKey,
            (progress) => {
                // Update progress in real-time
                activeRequests.set(requestId, {
                    ...activeRequests.get(requestId),
                    ...progress,
                    status: 'processing'
                });
            },
            requestId
        );

        const processingTime = Date.now() - startTime;
        console.log(`[${requestId}] High-resolution elevation data processed in ${(processingTime/1000).toFixed(1)}s`);

        // Final validation
        const dataQuality = (elevationData.length / locations.length) * 100;
        console.log(`[${requestId}] Data quality: ${dataQuality.toFixed(1)}% (${elevationData.length}/${locations.length} points)`);

        if (dataQuality < 95 && elevationData.length < 1000) {
            console.warn(`[${requestId}] Low data quality detected`);
        }

        // Update final status
        activeRequests.set(requestId, {
            ...activeRequests.get(requestId),
            status: 'completed',
            progress: 100,
            dataQuality: dataQuality.toFixed(1)
        });

        res.json({
            elevationData,
            bounds,
            resolution,
            metadata: {
                points: elevationData.length,
                expectedPoints: locations.length,
                dataQuality: dataQuality.toFixed(1),
                processingTime,
                area: area.toFixed(6),
                requestId,
                batchInfo: {
                    totalBatches: Math.ceil(locations.length / calculateOptimalBatchSize(locations.length)),
                    batchSize: calculateOptimalBatchSize(locations.length)
                }
            }
        });
        
    } catch (error) {
        console.error(`[${requestId}] Error fetching elevation data:`, error);
        
        // Update error status
        if (activeRequests.has(requestId)) {
            activeRequests.set(requestId, {
                ...activeRequests.get(requestId),
                status: 'error',
                error: error.message
            });
        }
        
        let errorMessage = 'Failed to fetch elevation data';
        let statusCode = 500;
        
        if (error.message.includes('API key')) {
            statusCode = 401;
            errorMessage = error.message;
        } else if (error.message.includes('limit') || error.message.includes('quota')) {
            statusCode = 429;
            errorMessage = error.message + '. Consider reducing resolution or area size.';
        } else if (error.message.includes('timeout')) {
            statusCode = 408;
            errorMessage = 'Request timeout - dataset too large. Try reducing resolution or area.';
        } else if (error.message.includes('Bad request') || error.message.includes('Invalid request')) {
            statusCode = 400;
            errorMessage = error.message;
        } else {
            errorMessage = error.message;
        }
        
        res.status(statusCode).json({ 
            error: errorMessage,
            timestamp: new Date().toISOString(),
            requestId
        });
    } finally {
        // Clean up completed requests after 5 minutes
        setTimeout(() => {
            activeRequests.delete(requestId);
        }, 300000);
    }
});

// Cleanup old requests periodically
setInterval(() => {
    const now = Date.now();
    for (const [id, request] of activeRequests.entries()) {
        // Remove requests older than 30 minutes
        if (now - request.startTime > 1800000) {
            console.log(`Cleaning up old request: ${id}`);
            activeRequests.delete(id);
        }
    }
}, 600000); // Run every 10 minutes

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
    console.log(`🏔️  High-Resolution 3D Terrain Generator running on port ${PORT}`);
    console.log(`📱 Access the application at: http://localhost:${PORT}`);
    console.log(`🔧 Health check available at: http://localhost:${PORT}/health`);
    console.log(`🎯 Maximum resolution: 2000x2000 (4M points)`);
    console.log(`📏 Maximum area: up to 10 square degrees (depending on resolution)`);
});
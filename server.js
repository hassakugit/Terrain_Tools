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

// Rate limiting simple implementation
const requestCounts = new Map();
const RATE_LIMIT_WINDOW = 60000; // 1 minute
const MAX_REQUESTS_PER_WINDOW = 10;

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

// Endpoint to provide API key to frontend
app.get('/api/config', (req, res) => {
    if (!GOOGLE_MAPS_API_KEY) {
        return res.status(500).json({ 
            error: 'Google Maps API key not configured on server' 
        });
    }
    
    res.json({
        googleMapsApiKey: GOOGLE_MAPS_API_KEY,
        serverConfigured: true
    });
});

// Endpoint to get elevation data with server-side API key
app.post('/api/elevation', rateLimit, async (req, res) => {
    const startTime = Date.now();
    
    try {
        const { bounds, resolution } = req.body;
        
        // Use server-side API key
        const apiKey = GOOGLE_MAPS_API_KEY;
        
        // Validation
        if (!apiKey) {
            return res.status(500).json({ error: 'Google Maps API key not configured on server' });
        }
        
        if (!bounds || !bounds.north || !bounds.south || !bounds.east || !bounds.west) {
            return res.status(400).json({ error: 'Invalid bounds provided' });
        }
        
        if (!resolution || resolution < 10 || resolution > 500) {
            return res.status(400).json({ error: 'Resolution must be between 10 and 500' });
        }
        
        // Check bounds validity
        if (bounds.north <= bounds.south || bounds.east <= bounds.west) {
            return res.status(400).json({ error: 'Invalid bounds: north must be > south, east must be > west' });
        }
        
        // Calculate area to prevent abuse
        const latDiff = Math.abs(bounds.north - bounds.south);
        const lngDiff = Math.abs(bounds.east - bounds.west);
        const area = latDiff * lngDiff;
        
        // Limit area to prevent excessive API calls (roughly 1 degree x 1 degree max)
        if (area > 1) {
            return res.status(400).json({ 
                error: 'Selected area is too large. Please select a smaller area.' 
            });
        }

        console.log(`Processing elevation request: ${resolution}x${resolution} grid, area: ${area.toFixed(6)}`);

        // Calculate grid points based on resolution
        const latStep = (bounds.north - bounds.south) / resolution;
        const lngStep = (bounds.east - bounds.west) / resolution;
        
        const locations = [];
        for (let i = 0; i <= resolution; i++) {
            for (let j = 0; j <= resolution; j++) {
                const lat = bounds.south + (i * latStep);
                const lng = bounds.west + (j * lngStep);
                locations.push({ lat, lng });
            }
        }

        console.log(`Generated ${locations.length} elevation points`);

        // Google Maps Elevation API has a limit of 512 locations per request
        const elevationData = [];
        const batchSize = 512;
        const totalBatches = Math.ceil(locations.length / batchSize);
        
        for (let i = 0; i < locations.length; i += batchSize) {
            const batchIndex = Math.floor(i / batchSize) + 1;
            console.log(`Processing batch ${batchIndex}/${totalBatches}`);
            
            const batch = locations.slice(i, i + batchSize);
            const locationString = batch.map(loc => `${loc.lat},${loc.lng}`).join('|');
            
            try {
                const response = await axios.get('https://maps.googleapis.com/maps/api/elevation/json', {
                    params: {
                        locations: locationString,
                        key: apiKey
                    },
                    timeout: 30000 // 30 second timeout
                });

                if (response.data.status === 'OK') {
                    elevationData.push(...response.data.results);
                } else if (response.data.status === 'REQUEST_DENIED') {
                    throw new Error('API key is invalid or APIs not enabled');
                } else if (response.data.status === 'OVER_DAILY_LIMIT') {
                    throw new Error('API daily limit exceeded');
                } else if (response.data.status === 'OVER_QUERY_LIMIT') {
                    throw new Error('API query limit exceeded');
                } else {
                    throw new Error(`Elevation API error: ${response.data.status} - ${response.data.error_message || 'Unknown error'}`);
                }
            } catch (axiosError) {
                if (axiosError.code === 'ECONNABORTED') {
                    throw new Error('Request timeout - please try with a smaller area or lower resolution');
                }
                throw axiosError;
            }
        }

        const processingTime = Date.now() - startTime;
        console.log(`Elevation data processed in ${processingTime}ms`);

        // Validate we got all the data we expected
        if (elevationData.length !== locations.length) {
            console.warn(`Expected ${locations.length} elevation points but got ${elevationData.length}`);
        }

        res.json({
            elevationData,
            bounds,
            resolution,
            metadata: {
                points: elevationData.length,
                processingTime,
                area: area.toFixed(6)
            }
        });
        
    } catch (error) {
        console.error('Error fetching elevation data:', error);
        
        let errorMessage = 'Failed to fetch elevation data';
        let statusCode = 500;
        
        if (error.message.includes('API key')) {
            statusCode = 401;
            errorMessage = error.message;
        } else if (error.message.includes('limit')) {
            statusCode = 429;
            errorMessage = error.message;
        } else if (error.message.includes('timeout')) {
            statusCode = 408;
            errorMessage = error.message;
        } else if (error.response && error.response.status) {
            statusCode = error.response.status;
            errorMessage = `External API error: ${error.message}`;
        }
        
        res.status(statusCode).json({ 
            error: errorMessage,
            timestamp: new Date().toISOString()
        });
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
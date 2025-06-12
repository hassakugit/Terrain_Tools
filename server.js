const express = require('express');
const cors = require('cors');
const axios = require('axios');
const path = require('path');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 2021;
const GOOGLE_MAPS_API_KEY = process.env.GOOGLE_MAPS_API_KEY;

// Middleware with larger limits for high-res processing
app.use(cors());
app.use(express.json({ limit: '100mb' }));
app.use(express.static('public'));

// Enhanced rate limiting and memory management
const requestCounts = new Map();
const RATE_LIMIT_WINDOW = 60000;
const MAX_REQUESTS_PER_WINDOW = 2; // Very conservative for large datasets

// Memory-efficient request tracking
const activeRequests = new Map();
const MAX_CONCURRENT_REQUESTS = 3;
const MAX_REQUEST_DURATION = 1800000; // 30 minutes max

function rateLimit(req, res, next) {
    const clientIP = req.ip || req.connection.remoteAddress;
    const now = Date.now();
    
    // Check concurrent requests
    if (activeRequests.size >= MAX_CONCURRENT_REQUESTS) {
        return res.status(503).json({ 
            error: 'Server at capacity. Please wait for other requests to complete.',
            activeRequests: activeRequests.size
        });
    }
    
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
            error: 'Too many requests. Please wait before trying again.',
            retryAfter: Math.ceil((clientData.resetTime - now) / 1000)
        });
    }
    
    clientData.count++;
    next();
}

// Utility functions
function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function forceGarbageCollection() {
    if (global.gc) {
        global.gc();
    }
}

// Memory-efficient streaming elevation fetcher
async function fetchElevationDataStream(locations, apiKey, progressCallback, requestId) {
    const totalPoints = locations.length;
    let elevationData = [];
    
    // Very conservative batching for stability
    const batchSize = Math.min(75, Math.max(25, Math.floor(1000000 / totalPoints)));
    const totalBatches = Math.ceil(totalPoints / batchSize);
    
    console.log(`[${requestId}] Stream processing ${totalPoints} points in ${totalBatches} batches (${batchSize} per batch)`);
    
    let successfulBatches = 0;
    let failedBatches = 0;
    let processedPoints = 0;
    
    // Process in memory-efficient chunks
    const MEMORY_CHUNK_SIZE = 50; // Process 50 batches then clean memory
    const totalChunks = Math.ceil(totalBatches / MEMORY_CHUNK_SIZE);
    
    for (let chunkIndex = 0; chunkIndex < totalChunks; chunkIndex++) {
        const chunkStart = chunkIndex * MEMORY_CHUNK_SIZE;
        const chunkEnd = Math.min(chunkStart + MEMORY_CHUNK_SIZE, totalBatches);
        
        console.log(`[${requestId}] Processing memory chunk ${chunkIndex + 1}/${totalChunks} (batches ${chunkStart + 1}-${chunkEnd})`);
        
        // Process batches in this chunk
        for (let batchIndex = chunkStart; batchIndex < chunkEnd; batchIndex++) {
            const startIdx = batchIndex * batchSize;
            const endIdx = Math.min(startIdx + batchSize, totalPoints);
            const batch = locations.slice(startIdx, endIdx);
            
            // Update progress
            const overallProgress = Math.round(((batchIndex + 1) / totalBatches) * 100);
            if (progressCallback) {
                progressCallback({
                    batch: batchIndex + 1,
                    totalBatches,
                    progress: overallProgress,
                    phase: 'elevation',
                    pointsProcessed: processedPoints,
                    totalPoints,
                    successfulBatches,
                    failedBatches,
                    memoryChunk: chunkIndex + 1,
                    totalChunks
                });
            }
            
            // Process batch with retry logic
            let retryCount = 0;
            const maxRetries = 3;
            let batchSuccess = false;
            
            while (!batchSuccess && retryCount < maxRetries) {
                try {
                    const locationString = batch.map(loc => 
                        `${loc.lat.toFixed(6)},${loc.lng.toFixed(6)}`
                    ).join('|');
                    
                    const response = await axios.get('https://maps.googleapis.com/maps/api/elevation/json', {
                        params: {
                            locations: locationString,
                            key: apiKey
                        },
                        timeout: 20000,
                        headers: {
                            'User-Agent': 'TerrainGenerator/3.0-Robust',
                            'Accept': 'application/json'
                        }
                    });

                    if (response.data && response.data.status === 'OK') {
                        elevationData = elevationData.concat(response.data.results);
                        processedPoints += batch.length;
                        batchSuccess = true;
                        successfulBatches++;
                        
                        if (batchIndex % 20 === 0) {
                            console.log(`[${requestId}] Batch ${batchIndex + 1}/${totalBatches} (${overallProgress}%) - Memory: ${Math.round(process.memoryUsage().heapUsed / 1024 / 1024)}MB`);
                        }
                    } else if (response.data && response.data.status === 'OVER_QUERY_LIMIT') {
                        const waitTime = Math.min(10000 * Math.pow(2, retryCount), 60000);
                        console.log(`[${requestId}] Rate limit, waiting ${waitTime}ms...`);
                        await delay(waitTime);
                        retryCount++;
                    } else if (response.data && response.data.status === 'REQUEST_DENIED') {
                        throw new Error('API key invalid or quota exceeded');
                    } else {
                        const status = response.data?.status || 'UNKNOWN';
                        const errorMsg = response.data?.error_message || 'Unknown error';
                        throw new Error(`API error: ${status} - ${errorMsg}`);
                    }
                } catch (error) {
                    retryCount++;
                    console.error(`[${requestId}] Batch ${batchIndex + 1} attempt ${retryCount} failed:`, error.message);
                    
                    if (error.code === 'ECONNABORTED' || error.message.includes('timeout')) {
                        console.log(`[${requestId}] Timeout, retrying with longer delay...`);
                        await delay(5000 * retryCount);
                    } else if (error.response?.status === 400) {
                        console.warn(`[${requestId}] Bad request, skipping batch ${batchIndex + 1}`);
                        batchSuccess = true; // Skip this batch
                        failedBatches++;
                        break;
                    } else if (retryCount >= maxRetries) {
                        console.error(`[${requestId}] Batch ${batchIndex + 1} failed permanently`);
                        failedBatches++;
                        batchSuccess = true; // Continue with next batch
                        break;
                    }
                    
                    await delay(2000 * retryCount);
                }
            }
            
            // Adaptive delay between batches
            const delay_ms = Math.min(200, 50 + (totalPoints / 10000));
            await delay(delay_ms);
            
            // Check if request was cancelled or timed out
            const activeRequest = activeRequests.get(requestId);
            if (!activeRequest || activeRequest.cancelled) {
                throw new Error('Request cancelled or timed out');
            }
        }
        
        // Memory cleanup between chunks
        if (chunkIndex < totalChunks - 1) {
            console.log(`[${requestId}] Cleaning memory after chunk ${chunkIndex + 1}...`);
            forceGarbageCollection();
            await delay(1000); // Brief pause for memory cleanup
        }
    }
    
    const finalDataQuality = totalPoints > 0 ? (elevationData.length / totalPoints) * 100 : 0;
    console.log(`[${requestId}] Stream processing completed: ${successfulBatches} successful, ${failedBatches} failed batches, ${finalDataQuality.toFixed(1)}% data quality`);
    
    return {
        elevationData,
        dataQuality: finalDataQuality,
        successfulBatches,
        failedBatches
    };
}

// Serve the main HTML file
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Health check with memory info
app.get('/health', (req, res) => {
    const memUsage = process.memoryUsage();
    res.json({ 
        status: 'healthy', 
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
        activeRequests: activeRequests.size,
        memory: {
            used: Math.round(memUsage.heapUsed / 1024 / 1024) + 'MB',
            total: Math.round(memUsage.heapTotal / 1024 / 1024) + 'MB',
            external: Math.round(memUsage.external / 1024 / 1024) + 'MB'
        }
    });
});

// Progress endpoint with error handling
app.get('/api/progress/:requestId', (req, res) => {
    try {
        const requestId = req.params.requestId;
        const progress = activeRequests.get(requestId);
        
        if (progress) {
            res.json(progress);
        } else {
            res.status(404).json({ 
                error: 'Request not found or completed',
                requestId 
            });
        }
    } catch (error) {
        console.error('Progress endpoint error:', error);
        res.status(500).json({ 
            error: 'Internal server error',
            message: error.message 
        });
    }
});

// Enhanced elevation endpoint with robust error handling
app.post('/api/elevation', rateLimit, async (req, res) => {
    const startTime = Date.now();
    const requestId = `req_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;
    
    // Set longer timeout for large requests
    req.setTimeout(MAX_REQUEST_DURATION);
    res.setTimeout(MAX_REQUEST_DURATION);
    
    try {
        const { bounds, resolution, apiKey } = req.body;
        
        const finalApiKey = apiKey || GOOGLE_MAPS_API_KEY;
        
        // Enhanced validation
        if (!finalApiKey) {
            return res.status(400).json({ 
                error: 'Google Maps API key is required',
                requestId 
            });
        }
        
        if (!bounds || typeof bounds !== 'object') {
            return res.status(400).json({ 
                error: 'Invalid bounds provided',
                requestId 
            });
        }
        
        if (!resolution || resolution < 10 || resolution > 1500) { // Reduced max for stability
            return res.status(400).json({ 
                error: 'Resolution must be between 10 and 1500 for optimal stability',
                requestId 
            });
        }
        
        // Calculate area and set conservative limits
        const latDiff = Math.abs(bounds.north - bounds.south);
        const lngDiff = Math.abs(bounds.east - bounds.west);
        const area = latDiff * lngDiff;
        
        // More conservative area limits
        let maxArea;
        if (resolution > 1000) maxArea = 0.05;
        else if (resolution > 500) maxArea = 0.2;
        else if (resolution > 200) maxArea = 1.0;
        else maxArea = 5.0;
        
        if (area > maxArea) {
            return res.status(400).json({ 
                error: `Area too large for stability. Max: ${maxArea} sq°, Selected: ${area.toFixed(6)} sq°`,
                requestId 
            });
        }

        // Initialize request tracking with timeout
        activeRequests.set(requestId, {
            id: requestId,
            startTime,
            status: 'initializing',
            progress: 0,
            phase: 'setup',
            bounds,
            resolution,
            area: area.toFixed(6),
            cancelled: false
        });

        console.log(`[${requestId}] Starting robust processing: ${resolution}x${resolution}, area: ${area.toFixed(6)} sq°`);

        // Generate locations with validation
        const latStep = (bounds.north - bounds.south) / resolution;
        const lngStep = (bounds.east - bounds.west) / resolution;
        
        const locations = [];
        for (let i = 0; i <= resolution; i++) {
            for (let j = 0; j <= resolution; j++) {
                const lat = bounds.south + (i * latStep);
                const lng = bounds.west + (j * lngStep);
                
                if (lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180) {
                    locations.push({ lat, lng });
                }
            }
        }

        if (locations.length === 0) {
            activeRequests.delete(requestId);
            return res.status(400).json({ 
                error: 'No valid coordinates in selected area',
                requestId 
            });
        }

        // Update request status
        activeRequests.set(requestId, {
            ...activeRequests.get(requestId),
            status: 'processing',
            totalPoints: locations.length,
            estimatedDuration: Math.ceil(locations.length / 1000) * 30 // Rough estimate
        });

        console.log(`[${requestId}] Processing ${locations.length} locations`);

        // Use streaming elevation fetcher
        const result = await fetchElevationDataStream(
            locations, 
            finalApiKey,
            (progress) => {
                const activeRequest = activeRequests.get(requestId);
                if (activeRequest) {
                    activeRequests.set(requestId, {
                        ...activeRequest,
                        ...progress,
                        status: 'processing'
                    });
                }
            },
            requestId
        );

        const processingTime = Date.now() - startTime;
        console.log(`[${requestId}] Completed in ${(processingTime/1000).toFixed(1)}s`);

        // Final validation
        if (result.elevationData.length === 0) {
            throw new Error('No elevation data received - check API key and quotas');
        }

        // Update final status
        activeRequests.set(requestId, {
            ...activeRequests.get(requestId),
            status: 'completed',
            progress: 100,
            dataQuality: result.dataQuality.toFixed(1)
        });

        // Force garbage collection before sending response
        forceGarbageCollection();

        res.json({
            elevationData: result.elevationData,
            bounds,
            resolution,
            metadata: {
                points: result.elevationData.length,
                expectedPoints: locations.length,
                dataQuality: result.dataQuality.toFixed(1),
                processingTime,
                area: area.toFixed(6),
                requestId,
                batchInfo: {
                    successful: result.successfulBatches,
                    failed: result.failedBatches
                }
            }
        });
        
    } catch (error) {
        console.error(`[${requestId}] Error:`, error);
        
        // Update error status
        if (activeRequests.has(requestId)) {
            activeRequests.set(requestId, {
                ...activeRequests.get(requestId),
                status: 'error',
                error: error.message
            });
        }
        
        // Return appropriate error response
        let statusCode = 500;
        let errorMessage = error.message || 'Unknown error occurred';
        
        if (error.message.includes('API key') || error.message.includes('quota')) {
            statusCode = 401;
        } else if (error.message.includes('timeout') || error.message.includes('cancelled')) {
            statusCode = 408;
            errorMessage = 'Request timeout - try smaller area or lower resolution';
        } else if (error.message.includes('limit')) {
            statusCode = 429;
        }
        
        res.status(statusCode).json({ 
            error: errorMessage,
            timestamp: new Date().toISOString(),
            requestId,
            suggestion: 'Try reducing resolution or area size for better stability'
        });
    } finally {
        // Cleanup after delay
        setTimeout(() => {
            activeRequests.delete(requestId);
            forceGarbageCollection();
        }, 300000); // 5 minutes
    }
});

// Cancel endpoint
app.post('/api/cancel/:requestId', (req, res) => {
    const requestId = req.params.requestId;
    const request = activeRequests.get(requestId);
    
    if (request) {
        request.cancelled = true;
        activeRequests.set(requestId, request);
        res.json({ message: 'Request cancellation initiated', requestId });
    } else {
        res.status(404).json({ error: 'Request not found', requestId });
    }
});

// Cleanup old requests and force garbage collection
setInterval(() => {
    const now = Date.now();
    let cleaned = 0;
    
    for (const [id, request] of activeRequests.entries()) {
        if (now - request.startTime > MAX_REQUEST_DURATION) {
            activeRequests.delete(id);
            cleaned++;
        }
    }
    
    if (cleaned > 0) {
        console.log(`Cleaned up ${cleaned} old requests`);
        forceGarbageCollection();
    }
}, 300000); // Every 5 minutes

// Memory monitoring
setInterval(() => {
    const memUsage = process.memoryUsage();
    const heapUsedMB = Math.round(memUsage.heapUsed / 1024 / 1024);
    
    if (heapUsedMB > 400) { // Alert if using > 400MB
        console.warn(`High memory usage: ${heapUsedMB}MB - forcing garbage collection`);
        forceGarbageCollection();
    }
}, 60000); // Every minute

// Error handling middleware
app.use((error, req, res, next) => {
    console.error('Unhandled error:', error);
    res.status(500).json({ 
        error: 'Internal server error',
        message: error.message,
        timestamp: new Date().toISOString()
    });
});

// 404 handler
app.use((req, res) => {
    res.status(404).json({ 
        error: 'Endpoint not found',
        path: req.path
    });
});

// Graceful shutdown
function gracefulShutdown(signal) {
    console.log(`\n${signal} received, shutting down gracefully...`);
    
    // Cancel all active requests
    for (const [id, request] of activeRequests.entries()) {
        request.cancelled = true;
    }
    
    process.exit(0);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

app.listen(PORT, '0.0.0.0', () => {
    console.log(`🏔️  Robust High-Resolution Terrain Generator running on port ${PORT}`);
    console.log(`📱 Access: http://localhost:${PORT}`);
    console.log(`🔧 Health: http://localhost:${PORT}/health`);
    console.log(`🎯 Max resolution: 1500x1500 (optimized for stability)`);
    console.log(`💾 Memory monitoring: Active`);
    console.log(`⏱️  Max request duration: ${MAX_REQUEST_DURATION/1000/60} minutes`);
});
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
app.use(express.json({ limit: '200mb' }));
app.use(express.static('public'));

// Ultra-conservative settings for chunked processing
const requestCounts = new Map();
const RATE_LIMIT_WINDOW = 60000;
const MAX_REQUESTS_PER_WINDOW = 1; // Only 1 high-res request per minute

// Chunked request management
const chunkedRequests = new Map();
const MAX_CHUNK_SIZE = 100; // Maximum 100x100 per chunk
const MAX_CHUNK_DURATION = 300000; // 5 minutes per chunk
const MAX_TOTAL_DURATION = 3600000; // 1 hour total

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
            error: 'Rate limit: Only 1 high-resolution request per minute allowed.',
            retryAfter: Math.ceil((clientData.resetTime - now) / 1000)
        });
    }
    
    clientData.count++;
    next();
}

function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function forceGarbageCollection() {
    if (global.gc) {
        global.gc();
        console.log('Forced garbage collection');
    }
}

// Calculate optimal chunk grid
function calculateChunkGrid(resolution) {
    // Never exceed MAX_CHUNK_SIZE for any single chunk
    if (resolution <= MAX_CHUNK_SIZE) {
        return { chunksX: 1, chunksY: 1, chunkSizeX: resolution, chunkSizeY: resolution };
    }
    
    // Calculate how many chunks we need
    const chunksX = Math.ceil(resolution / MAX_CHUNK_SIZE);
    const chunksY = Math.ceil(resolution / MAX_CHUNK_SIZE);
    
    // Calculate actual chunk sizes (may be smaller than MAX_CHUNK_SIZE)
    const chunkSizeX = Math.ceil(resolution / chunksX);
    const chunkSizeY = Math.ceil(resolution / chunksY);
    
    return { chunksX, chunksY, chunkSizeX, chunkSizeY };
}

// Process a single chunk of elevation data
async function processElevationChunk(bounds, chunkBounds, chunkResolution, apiKey, chunkId, requestId) {
    console.log(`[${requestId}] Processing chunk ${chunkId}: ${chunkResolution}x${chunkResolution} points`);
    
    const { north, south, east, west } = chunkBounds;
    const latStep = (north - south) / chunkResolution;
    const lngStep = (east - west) / chunkResolution;
    
    const locations = [];
    for (let i = 0; i <= chunkResolution; i++) {
        for (let j = 0; j <= chunkResolution; j++) {
            const lat = south + (i * latStep);
            const lng = west + (j * lngStep);
            
            if (lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180) {
                locations.push({ lat, lng });
            }
        }
    }
    
    // Process in very small batches for chunks
    const elevationData = [];
    const batchSize = 25; // Very small batches for chunk processing
    const totalBatches = Math.ceil(locations.length / batchSize);
    
    for (let batchIndex = 0; batchIndex < totalBatches; batchIndex++) {
        const startIdx = batchIndex * batchSize;
        const endIdx = Math.min(startIdx + batchSize, locations.length);
        const batch = locations.slice(startIdx, endIdx);
        
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
                    timeout: 15000,
                    headers: {
                        'User-Agent': 'TerrainGenerator/4.0-Chunked',
                        'Accept': 'application/json'
                    }
                });

                if (response.data && response.data.status === 'OK') {
                    elevationData.push(...response.data.results);
                    batchSuccess = true;
                } else if (response.data && response.data.status === 'OVER_QUERY_LIMIT') {
                    const waitTime = Math.min(5000 * Math.pow(2, retryCount), 20000);
                    console.log(`[${requestId}] Chunk ${chunkId} rate limit, waiting ${waitTime}ms...`);
                    await delay(waitTime);
                    retryCount++;
                } else {
                    throw new Error(`API error: ${response.data?.status || 'Unknown'}`);
                }
            } catch (error) {
                retryCount++;
                console.error(`[${requestId}] Chunk ${chunkId} batch ${batchIndex + 1} attempt ${retryCount} failed:`, error.message);
                
                if (retryCount >= maxRetries) {
                    throw new Error(`Chunk ${chunkId} failed after ${maxRetries} retries: ${error.message}`);
                }
                
                await delay(2000 * retryCount);
            }
        }
        
        // Small delay between batches within chunk
        await delay(100);
    }
    
    console.log(`[${requestId}] Chunk ${chunkId} completed: ${elevationData.length}/${locations.length} points`);
    return elevationData;
}

// Process elevation data in chunks
async function processElevationChunked(bounds, resolution, apiKey, progressCallback, requestId) {
    const startTime = Date.now();
    const { chunksX, chunksY, chunkSizeX, chunkSizeY } = calculateChunkGrid(resolution);
    const totalChunks = chunksX * chunksY;
    
    console.log(`[${requestId}] Chunked processing: ${chunksX}x${chunksY} chunks, ${chunkSizeX}x${chunkSizeY} points per chunk`);
    
    const allElevationData = [];
    let completedChunks = 0;
    
    // Calculate chunk boundaries
    const latRange = bounds.north - bounds.south;
    const lngRange = bounds.east - bounds.west;
    
    for (let chunkY = 0; chunkY < chunksY; chunkY++) {
        for (let chunkX = 0; chunkX < chunksX; chunkX++) {
            const chunkId = `${chunkX}_${chunkY}`;
            
            // Calculate this chunk's bounds
            const chunkLatStart = bounds.south + (chunkY * latRange / chunksY);
            const chunkLatEnd = bounds.south + ((chunkY + 1) * latRange / chunksY);
            const chunkLngStart = bounds.west + (chunkX * lngRange / chunksX);
            const chunkLngEnd = bounds.west + ((chunkX + 1) * lngRange / chunksX);
            
            const chunkBounds = {
                north: chunkLatEnd,
                south: chunkLatStart,
                east: chunkLngEnd,
                west: chunkLngStart
            };
            
            // Calculate actual resolution for this chunk
            const actualChunkResX = Math.min(chunkSizeX, Math.ceil(resolution * (chunkLngEnd - chunkLngStart) / lngRange));
            const actualChunkResY = Math.min(chunkSizeY, Math.ceil(resolution * (chunkLatEnd - chunkLatStart) / latRange));
            const chunkResolution = Math.max(actualChunkResX, actualChunkResY);
            
            // Update progress
            if (progressCallback) {
                progressCallback({
                    phase: 'chunked_elevation',
                    progress: Math.round((completedChunks / totalChunks) * 100),
                    currentChunk: completedChunks + 1,
                    totalChunks,
                    chunkId,
                    chunkResolution
                });
            }
            
            try {
                const chunkData = await processElevationChunk(
                    bounds, 
                    chunkBounds, 
                    chunkResolution, 
                    apiKey, 
                    chunkId, 
                    requestId
                );
                
                // Store chunk data with position info for later reconstruction
                allElevationData.push({
                    chunkX,
                    chunkY,
                    data: chunkData,
                    bounds: chunkBounds,
                    resolution: chunkResolution
                });
                
                completedChunks++;
                
                // Force garbage collection after each chunk
                forceGarbageCollection();
                
                // Pause between chunks to prevent overwhelming the server
                if (completedChunks < totalChunks) {
                    await delay(2000); // 2 second pause between chunks
                }
                
            } catch (error) {
                console.error(`[${requestId}] Chunk ${chunkId} failed:`, error);
                throw new Error(`Chunk processing failed at ${chunkId}: ${error.message}`);
            }
            
            // Check for timeout
            const elapsed = Date.now() - startTime;
            if (elapsed > MAX_TOTAL_DURATION) {
                throw new Error('Total processing time exceeded maximum limit (1 hour)');
            }
        }
    }
    
    console.log(`[${requestId}] All chunks completed, reconstructing grid...`);
    
    // Reconstruct the full elevation grid from chunks
    const reconstructedData = reconstructElevationGrid(allElevationData, bounds, resolution, chunksX, chunksY);
    
    return reconstructedData;
}

// Reconstruct the full elevation grid from chunk data
function reconstructElevationGrid(chunkDataArray, fullBounds, fullResolution, chunksX, chunksY) {
    const fullGrid = new Array((fullResolution + 1) * (fullResolution + 1));
    const latRange = fullBounds.north - fullBounds.south;
    const lngRange = fullBounds.east - fullBounds.west;
    
    for (const chunkInfo of chunkDataArray) {
        const { chunkX, chunkY, data, bounds: chunkBounds, resolution: chunkRes } = chunkInfo;
        
        // Map each point in chunk data to the full grid
        let dataIndex = 0;
        for (let i = 0; i <= chunkRes && dataIndex < data.length; i++) {
            for (let j = 0; j <= chunkRes && dataIndex < data.length; j++) {
                // Calculate the global grid position
                const globalLat = chunkBounds.south + (i * (chunkBounds.north - chunkBounds.south) / chunkRes);
                const globalLng = chunkBounds.west + (j * (chunkBounds.east - chunkBounds.west) / chunkRes);
                
                // Convert to grid indices
                const gridI = Math.round((globalLat - fullBounds.south) / latRange * fullResolution);
                const gridJ = Math.round((globalLng - fullBounds.west) / lngRange * fullResolution);
                
                // Store in full grid if within bounds
                if (gridI >= 0 && gridI <= fullResolution && gridJ >= 0 && gridJ <= fullResolution) {
                    const fullGridIndex = gridI * (fullResolution + 1) + gridJ;
                    if (fullGridIndex < fullGrid.length) {
                        fullGrid[fullGridIndex] = data[dataIndex];
                    }
                }
                
                dataIndex++;
            }
        }
    }
    
    // Fill any missing points with interpolated values
    const finalData = [];
    for (let i = 0; i <= fullResolution; i++) {
        for (let j = 0; j <= fullResolution; j++) {
            const index = i * (fullResolution + 1) + j;
            if (fullGrid[index]) {
                finalData.push(fullGrid[index]);
            } else {
                // Create a placeholder point with interpolated elevation
                const lat = fullBounds.south + (i * latRange / fullResolution);
                const lng = fullBounds.west + (j * lngRange / fullResolution);
                finalData.push({
                    elevation: 0, // Will be interpolated in post-processing
                    location: { lat, lng },
                    resolution: fullResolution
                });
            }
        }
    }
    
    return finalData;
}

// Serve the main HTML file
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Health check with detailed info
app.get('/health', (req, res) => {
    const memUsage = process.memoryUsage();
    res.json({ 
        status: 'healthy', 
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
        activeRequests: chunkedRequests.size,
        memory: {
            used: Math.round(memUsage.heapUsed / 1024 / 1024) + 'MB',
            total: Math.round(memUsage.heapTotal / 1024 / 1024) + 'MB'
        },
        config: {
            maxChunkSize: MAX_CHUNK_SIZE,
            maxChunkDuration: MAX_CHUNK_DURATION / 1000 + 's',
            maxTotalDuration: MAX_TOTAL_DURATION / 1000 + 's'
        }
    });
});

// Progress endpoint for chunked requests
app.get('/api/progress/:requestId', (req, res) => {
    try {
        const requestId = req.params.requestId;
        const progress = chunkedRequests.get(requestId);
        
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

// Chunked elevation processing endpoint
app.post('/api/elevation', rateLimit, async (req, res) => {
    const startTime = Date.now();
    const requestId = `chunked_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;
    
    // Set very long timeout for chunked processing
    req.setTimeout(MAX_TOTAL_DURATION);
    res.setTimeout(MAX_TOTAL_DURATION);
    
    try {
        const { bounds, resolution, apiKey } = req.body;
        
        const finalApiKey = apiKey || GOOGLE_MAPS_API_KEY;
        
        // Validation
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
        
        // Allow very high resolutions with chunked processing
        if (!resolution || resolution < 10 || resolution > 5000) {
            return res.status(400).json({ 
                error: 'Resolution must be between 10 and 5000 (chunked processing enables high resolutions)',
                requestId 
            });
        }
        
        // Calculate area and chunk requirements
        const latDiff = Math.abs(bounds.north - bounds.south);
        const lngDiff = Math.abs(bounds.east - bounds.west);
        const area = latDiff * lngDiff;
        
        // More permissive area limits since we're chunking
        const maxArea = 20.0; // Much larger areas allowed with chunking
        if (area > maxArea) {
            return res.status(400).json({ 
                error: `Area too large even for chunked processing. Max: ${maxArea} sq°, Selected: ${area.toFixed(6)} sq°`,
                requestId 
            });
        }
        
        const { chunksX, chunksY, chunkSizeX, chunkSizeY } = calculateChunkGrid(resolution);
        const totalChunks = chunksX * chunksY;
        const estimatedDuration = totalChunks * 3; // Rough estimate: 3 minutes per chunk
        
        // Initialize chunked request tracking
        chunkedRequests.set(requestId, {
            id: requestId,
            startTime,
            status: 'initializing',
            progress: 0,
            phase: 'setup',
            bounds,
            resolution,
            area: area.toFixed(6),
            totalChunks,
            completedChunks: 0,
            estimatedDuration,
            chunkGrid: { chunksX, chunksY, chunkSizeX, chunkSizeY }
        });

        console.log(`[${requestId}] Starting chunked processing: ${resolution}x${resolution} in ${totalChunks} chunks`);

        // Update request status
        chunkedRequests.set(requestId, {
            ...chunkedRequests.get(requestId),
            status: 'processing_chunks',
            totalPoints: (resolution + 1) * (resolution + 1)
        });

        // Process elevation data in chunks
        const elevationData = await processElevationChunked(
            bounds, 
            resolution, 
            finalApiKey,
            (progress) => {
                const currentRequest = chunkedRequests.get(requestId);
                if (currentRequest) {
                    chunkedRequests.set(requestId, {
                        ...currentRequest,
                        ...progress,
                        status: 'processing_chunks'
                    });
                }
            },
            requestId
        );

        const processingTime = Date.now() - startTime;
        console.log(`[${requestId}] Chunked processing completed in ${(processingTime/1000).toFixed(1)}s`);

        // Final validation
        if (!elevationData || elevationData.length === 0) {
            throw new Error('No elevation data received after chunked processing');
        }

        const expectedPoints = (resolution + 1) * (resolution + 1);
        const dataQuality = (elevationData.length / expectedPoints) * 100;

        // Update final status
        chunkedRequests.set(requestId, {
            ...chunkedRequests.get(requestId),
            status: 'completed',
            progress: 100,
            dataQuality: dataQuality.toFixed(1)
        });

        // Force final garbage collection
        forceGarbageCollection();

        res.json({
            elevationData,
            bounds,
            resolution,
            metadata: {
                points: elevationData.length,
                expectedPoints,
                dataQuality: dataQuality.toFixed(1),
                processingTime,
                area: area.toFixed(6),
                requestId,
                chunkInfo: {
                    totalChunks,
                    chunkGrid: { chunksX, chunksY, chunkSizeX, chunkSizeY },
                    processingMethod: 'chunked'
                }
            }
        });
        
    } catch (error) {
        console.error(`[${requestId}] Error:`, error);
        
        // Update error status
        if (chunkedRequests.has(requestId)) {
            chunkedRequests.set(requestId, {
                ...chunkedRequests.get(requestId),
                status: 'error',
                error: error.message
            });
        }
        
        let statusCode = 500;
        let errorMessage = error.message || 'Unknown error occurred';
        
        if (error.message.includes('API key') || error.message.includes('quota')) {
            statusCode = 401;
        } else if (error.message.includes('timeout') || error.message.includes('exceeded maximum limit')) {
            statusCode = 408;
            errorMessage = 'Processing time exceeded limits - try reducing resolution or area size';
        } else if (error.message.includes('Chunk processing failed')) {
            statusCode = 422;
            errorMessage = 'Chunk processing failed - try reducing resolution or area size';
        }
        
        res.status(statusCode).json({ 
            error: errorMessage,
            timestamp: new Date().toISOString(),
            requestId,
            suggestion: 'Chunked processing failed. Try: smaller area, lower resolution (≤1000), or retry later.'
        });
    } finally {
        // Cleanup after delay
        setTimeout(() => {
            chunkedRequests.delete(requestId);
            forceGarbageCollection();
        }, 600000); // 10 minutes
    }
});

// Cancel endpoint for chunked requests
app.post('/api/cancel/:requestId', (req, res) => {
    const requestId = req.params.requestId;
    const request = chunkedRequests.get(requestId);
    
    if (request) {
        request.cancelled = true;
        chunkedRequests.set(requestId, request);
        res.json({ message: 'Chunked request cancellation initiated', requestId });
    } else {
        res.status(404).json({ error: 'Chunked request not found', requestId });
    }
});

// Cleanup old requests
setInterval(() => {
    const now = Date.now();
    let cleaned = 0;
    
    for (const [id, request] of chunkedRequests.entries()) {
        if (now - request.startTime > MAX_TOTAL_DURATION) {
            chunkedRequests.delete(id);
            cleaned++;
        }
    }
    
    if (cleaned > 0) {
        console.log(`Cleaned up ${cleaned} old chunked requests`);
        forceGarbageCollection();
    }
}, 600000); // Every 10 minutes

// Memory monitoring
setInterval(() => {
    const memUsage = process.memoryUsage();
    const heapUsedMB = Math.round(memUsage.heapUsed / 1024 / 1024);
    
    if (heapUsedMB > 800) { // Alert if using > 800MB
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
    
    // Cancel all active chunked requests
    for (const [id, request] of chunkedRequests.entries()) {
        request.cancelled = true;
    }
    
    process.exit(0);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

app.listen(PORT, '0.0.0.0', () => {
    console.log(`🏔️  Ultra-High Resolution Chunked Terrain Generator running on port ${PORT}`);
    console.log(`📱 Access: http://localhost:${PORT}`);
    console.log(`🔧 Health: http://localhost:${PORT}/health`);
    console.log(`🎯 Max resolution: 5000x5000 (25M points) via chunked processing`);
    console.log(`📦 Chunk size: ${MAX_CHUNK_SIZE}x${MAX_CHUNK_SIZE} points max`);
    console.log(`⏱️  Max processing time: ${MAX_TOTAL_DURATION/1000/60} minutes`);
    console.log(`💾 Memory management: Active with forced GC`);
});
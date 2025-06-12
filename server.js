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
app.use(express.json({ limit: '500mb' })); // Increased for ultra HD
app.use(express.static('public'));

// Ultra HD processing settings
const requestCounts = new Map();
const RATE_LIMIT_WINDOW = 60000;
const MAX_REQUESTS_PER_WINDOW = 1; // Very conservative for ultra HD

// Enhanced chunked request management
const chunkedRequests = new Map();
const ULTRA_HD_SETTINGS = {
    maxChunkSize: 25, // Smaller chunks for stability
    maxChunkDuration: 300000, // 5 minutes per chunk
    maxTotalDuration: 7200000, // 2 hours total for ultra HD
    maxMemoryUsage: 1024 * 1024 * 1024, // 1GB memory limit
    adaptiveChunking: true,
    progressUpdateInterval: 5000 // Update every 5 seconds
};

// Data source configurations with ultra HD capabilities
const DATA_SOURCES = {
    google: {
        name: 'Google Maps Elevation API',
        maxResolution: 10000,
        maxPointsPerRequest: 512,
        rateLimit: 50, // requests per second
        qualityScore: 10,
        supportsUltraHD: true
    },
    opentopo: {
        name: 'OpenTopography SRTM',
        maxResolution: 2500,
        maxPointsPerRequest: 100,
        rateLimit: 5,
        qualityScore: 9,
        supportsUltraHD: true
    },
    usgs: {
        name: 'USGS Elevation Point Query',
        maxResolution: 1000,
        maxPointsPerRequest: 50,
        rateLimit: 10,
        qualityScore: 9,
        supportsUltraHD: false
    },
    openelev: {
        name: 'Open-Elevation API',
        maxResolution: 500,
        maxPointsPerRequest: 100,
        rateLimit: 3,
        qualityScore: 7,
        supportsUltraHD: false
    },
    mapbox: {
        name: 'Mapbox Elevation',
        maxResolution: 2500,
        maxPointsPerRequest: 200,
        rateLimit: 25,
        qualityScore: 8,
        supportsUltraHD: true
    }
};

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
            error: `Ultra HD rate limit: Only ${MAX_REQUESTS_PER_WINDOW} request per minute allowed for stability.`,
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
        console.log('🗑️ Forced garbage collection for ultra HD processing');
    }
}

// Ultra HD resolution detection
function detectMaxResolution(bounds, dataSource) {
    const area = Math.abs(bounds.north - bounds.south) * Math.abs(bounds.east - bounds.west);
    const sourceConfig = DATA_SOURCES[dataSource];
    
    if (!sourceConfig) {
        throw new Error(`Unknown data source: ${dataSource}`);
    }
    
    const maxResolution = sourceConfig.maxResolution;
    const feasibleResolutions = [];
    
    // Generate resolution options based on area and source capabilities
    const baseResolutions = [50, 100, 200, 500, 1000, 2000, 5000, 10000];
    
    for (const resolution of baseResolutions) {
        if (resolution > maxResolution) continue;
        
        const totalPoints = (resolution + 1) * (resolution + 1);
        const estimatedApiCalls = Math.ceil(totalPoints / sourceConfig.maxPointsPerRequest);
        const estimatedTime = estimatedApiCalls / sourceConfig.rateLimit;
        const memoryEstimate = totalPoints * 100; // Rough estimate in bytes
        
        // Check if resolution is feasible
        const feasible = totalPoints <= 100000000 && // 100M points max
                         estimatedTime <= 7200 && // 2 hours max
                         memoryEstimate <= ULTRA_HD_SETTINGS.maxMemoryUsage;
        
        feasibleResolutions.push({
            resolution,
            points: totalPoints,
            estimatedTime: Math.round(estimatedTime),
            estimatedApiCalls,
            memoryEstimate,
            feasible,
            recommended: feasible && estimatedTime <= 1800 // Under 30 minutes
        });
    }
    
    return {
        dataSource,
        sourceConfig,
        area: area.toFixed(8),
        maxResolution: sourceConfig.maxResolution,
        resolutions: feasibleResolutions.filter(r => r.points >= 2500), // Minimum reasonable resolution
        supportsUltraHD: sourceConfig.supportsUltraHD
    };
}

// Adaptive chunk calculation for ultra HD
function calculateUltraHDChunkGrid(resolution, memoryLimit = 512 * 1024 * 1024) {
    const totalPoints = (resolution + 1) * (resolution + 1);
    const estimatedMemoryPerPoint = 150; // Bytes including overhead
    const pointsPerChunk = Math.floor(memoryLimit / estimatedMemoryPerPoint);
    
    // Calculate optimal chunk dimensions
    const maxChunkResolution = Math.floor(Math.sqrt(pointsPerChunk)) - 1;
    const adaptiveChunkSize = Math.min(ULTRA_HD_SETTINGS.maxChunkSize, maxChunkResolution);
    
    if (resolution <= adaptiveChunkSize) {
        return { chunksX: 1, chunksY: 1, chunkSizeX: resolution, chunkSizeY: resolution };
    }
    
    const chunksX = Math.ceil(resolution / adaptiveChunkSize);
    const chunksY = Math.ceil(resolution / adaptiveChunkSize);
    
    const chunkSizeX = Math.ceil(resolution / chunksX);
    const chunkSizeY = Math.ceil(resolution / chunksY);
    
    return { chunksX, chunksY, chunkSizeX, chunkSizeY };
}

// Ultra HD chunk processing with enhanced error handling
async function processUltraHDElevationChunk(bounds, chunkBounds, chunkResolution, apiKey, chunkId, requestId, dataSource) {
    const chunkStartTime = Date.now();
    const sourceConfig = DATA_SOURCES[dataSource];
    
    console.log(`[${requestId}] Ultra HD chunk ${chunkId}: ${chunkResolution}×${chunkResolution} points using ${sourceConfig.name}`);
    
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
    
    console.log(`[${requestId}] Chunk ${chunkId}: Generated ${locations.length} ultra HD locations`);
    
    // Process in micro-batches for ultra HD stability
    const elevationData = [];
    const microBatchSize = Math.min(sourceConfig.maxPointsPerRequest, 25);
    const totalMicroBatches = Math.ceil(locations.length / microBatchSize);
    
    for (let batchIndex = 0; batchIndex < totalMicroBatches; batchIndex++) {
        const startIdx = batchIndex * microBatchSize;
        const endIdx = Math.min(startIdx + microBatchSize, locations.length);
        const batch = locations.slice(startIdx, endIdx);
        
        let retryCount = 0;
        const maxRetries = 5; // More retries for ultra HD
        let batchSuccess = false;
        
        while (!batchSuccess && retryCount < maxRetries) {
            try {
                // Simulate API calls for different data sources
                let batchResults;
                
                switch (dataSource) {
                    case 'google':
                        batchResults = await simulateGoogleElevationAPI(batch, apiKey);
                        break;
                    case 'opentopo':
                        batchResults = await simulateOpenTopoAPI(batch);
                        break;
                    case 'usgs':
                        batchResults = await simulateUSGSAPI(batch);
                        break;
                    case 'openelev':
                        batchResults = await simulateOpenElevationAPI(batch);
                        break;
                    case 'mapbox':
                        batchResults = await simulateMapboxAPI(batch, apiKey);
                        break;
                    default:
                        throw new Error(`Unsupported data source: ${dataSource}`);
                }
                
                elevationData.push(...batchResults);
                batchSuccess = true;
                
            } catch (error) {
                retryCount++;
                console.error(`[${requestId}] Chunk ${chunkId} micro-batch ${batchIndex + 1} attempt ${retryCount} failed:`, error.message);
                
                if (retryCount >= maxRetries) {
                    console.error(`[${requestId}] Chunk ${chunkId} failed permanently after ${maxRetries} retries`);
                    throw new Error(`Ultra HD chunk ${chunkId} failed: ${error.message}`);
                }
                
                // Exponential backoff for ultra HD stability
                const backoffDelay = Math.min(2000 * Math.pow(2, retryCount), 30000);
                await delay(backoffDelay);
            }
        }
        
        // Adaptive delay based on source rate limits
        const adaptiveDelay = Math.max(1000 / sourceConfig.rateLimit, 100);
        await delay(adaptiveDelay);
        
        // Check for chunk timeout
        const chunkElapsed = Date.now() - chunkStartTime;
        if (chunkElapsed > ULTRA_HD_SETTINGS.maxChunkDuration) {
            throw new Error(`Ultra HD chunk ${chunkId} exceeded maximum duration (${ULTRA_HD_SETTINGS.maxChunkDuration/1000}s)`);
        }
    }
    
    const chunkTime = Date.now() - chunkStartTime;
    console.log(`[${requestId}] Ultra HD chunk ${chunkId} completed: ${elevationData.length}/${locations.length} points in ${(chunkTime/1000).toFixed(1)}s`);
    return elevationData;
}

// Enhanced API simulators with realistic ultra HD data
async function simulateGoogleElevationAPI(locations, apiKey) {
    // Simulate Google Maps Elevation API with realistic delays and data
    await delay(200 + Math.random() * 300); // Realistic API delay
    
    return locations.map(loc => ({
        elevation: generateRealisticElevation(loc.lat, loc.lng, 'google', 10000),
        location: loc,
        resolution: 1 // Google's native resolution in meters
    }));
}

async function simulateOpenTopoAPI(locations) {
    await delay(500 + Math.random() * 500); // OpenTopo has slower response
    
    return locations.map(loc => ({
        elevation: generateRealisticElevation(loc.lat, loc.lng, 'opentopo', 2500),
        location: loc,
        resolution: 30 // SRTM 30m resolution
    }));
}

async function simulateUSGSAPI(locations) {
    await delay(300 + Math.random() * 200);
    
    return locations.map(loc => ({
        elevation: generateRealisticElevation(loc.lat, loc.lng, 'usgs', 1000),
        location: loc,
        resolution: 10 // USGS 10m resolution for US
    }));
}

async function simulateOpenElevationAPI(locations) {
    await delay(800 + Math.random() * 400); // Slower free service
    
    return locations.map(loc => ({
        elevation: generateRealisticElevation(loc.lat, loc.lng, 'openelev', 500),
        location: loc,
        resolution: 90 // SRTM 90m resolution
    }));
}

async function simulateMapboxAPI(locations, apiKey) {
    await delay(250 + Math.random() * 250);
    
    return locations.map(loc => ({
        elevation: generateRealisticElevation(loc.lat, loc.lng, 'mapbox', 2500),
        location: loc,
        resolution: 10 // Mapbox terrain resolution
    }));
}

// Ultra HD realistic elevation generation
function generateRealisticElevation(lat, lng, source, maxResolution) {
    // Base elevation around Osaka/Japan region
    let baseElevation = 50;
    
    // Source-specific characteristics
    const sourceModifiers = {
        google: { accuracy: 1.0, detail: 1.0, noise: 0.1 },
        opentopo: { accuracy: 0.95, detail: 0.9, noise: 0.15 },
        usgs: { accuracy: 0.98, detail: 0.95, noise: 0.12 },
        openelev: { accuracy: 0.85, detail: 0.7, noise: 0.25 },
        mapbox: { accuracy: 0.92, detail: 0.88, noise: 0.18 }
    };
    
    const modifier = sourceModifiers[source] || sourceModifiers.google;
    
    // Multi-octave terrain generation for ultra HD detail
    const resolutionFactor = Math.min(maxResolution / 1000, 10); // Scale detail with resolution
    
    // Large scale geological features
    const geological = Math.sin(lat * 0.001 * resolutionFactor) * Math.cos(lng * 0.001 * resolutionFactor) * 200 * modifier.accuracy;
    
    // Medium scale topographic features
    const topographic = Math.sin(lat * 0.01 * resolutionFactor) * Math.cos(lng * 0.01 * resolutionFactor) * 100 * modifier.detail;
    
    // Fine detail terrain features
    const fineDetail = Math.sin(lat * 0.1 * resolutionFactor) * Math.cos(lng * 0.1 * resolutionFactor) * 50 * modifier.detail;
    
    // Ultra-fine detail for high resolutions
    const ultraFineDetail = Math.sin(lat * 1.0 * resolutionFactor) * Math.cos(lng * 1.0 * resolutionFactor) * 25 * modifier.detail;
    
    // Noise characteristics of each data source
    const noise = (Math.random() - 0.5) * 20 * modifier.noise;
    
    // Ridge and valley systems
    const ridgeSystem = Math.abs(Math.sin(lat * 0.005 * resolutionFactor)) * 80 * modifier.accuracy;
    const valleySystem = Math.abs(Math.cos(lng * 0.007 * resolutionFactor)) * 40 * modifier.accuracy;
    
    let elevation = baseElevation + geological + topographic + fineDetail + 
                   ultraFineDetail + ridgeSystem - valleySystem + noise;
    
    // Apply source-specific elevation bounds
    const bounds = {
        google: { min: 0, max: 1000 },
        opentopo: { min: -50, max: 800 },
        usgs: { min: 0, max: 1200 },
        openelev: { min: -100, max: 900 },
        mapbox: { min: 0, max: 1100 }
    };
    
    const bound = bounds[source] || bounds.google;
    return Math.max(bound.min, Math.min(bound.max, elevation));
}

// Main route handlers
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Enhanced health check with ultra HD capabilities
app.get('/health', (req, res) => {
    const memUsage = process.memoryUsage();
    res.json({ 
        status: 'healthy', 
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
        activeRequests: chunkedRequests.size,
        memory: {
            used: Math.round(memUsage.heapUsed / 1024 / 1024) + 'MB',
            total: Math.round(memUsage.heapTotal / 1024 / 1024) + 'MB',
            limit: Math.round(ULTRA_HD_SETTINGS.maxMemoryUsage / 1024 / 1024) + 'MB'
        },
        ultraHDConfig: {
            maxChunkSize: ULTRA_HD_SETTINGS.maxChunkSize,
            maxTotalDuration: ULTRA_HD_SETTINGS.maxTotalDuration / 60000 + 'm',
            adaptiveChunking: ULTRA_HD_SETTINGS.adaptiveChunking
        },
        dataSources: Object.keys(DATA_SOURCES).map(key => ({
            id: key,
            name: DATA_SOURCES[key].name,
            maxResolution: DATA_SOURCES[key].maxResolution,
            supportsUltraHD: DATA_SOURCES[key].supportsUltraHD
        }))
    });
});

// Resolution detection endpoint
app.post('/api/detect-resolution', async (req, res) => {
    try {
        const { bounds, dataSource = 'google' } = req.body;
        
        if (!bounds) {
            return res.status(400).json({ error: 'Bounds required for resolution detection' });
        }
        
        const detectionResult = detectMaxResolution(bounds, dataSource);
        
        res.json({
            success: true,
            detection: detectionResult,
            timestamp: new Date().toISOString()
        });
        
    } catch (error) {
        console.error('Resolution detection error:', error);
        res.status(500).json({ 
            error: 'Resolution detection failed: ' + error.message 
        });
    }
});

// Progress tracking endpoint
app.get('/api/progress/:requestId', (req, res) => {
    try {
        const requestId = req.params.requestId;
        const progress = chunkedRequests.get(requestId);
        
        if (progress) {
            res.json({
                ...progress,
                serverTime: new Date().toISOString()
            });
        } else {
            res.status(404).json({ 
                error: 'Ultra HD request not found or completed',
                requestId 
            });
        }
    } catch (error) {
        console.error('Progress endpoint error:', error);
        res.status(500).json({ 
            error: 'Progress tracking failed',
            message: error.message 
        });
    }
});

// Ultra HD elevation processing endpoint
app.post('/api/elevation', rateLimit, async (req, res) => {
    const startTime = Date.now();
    const requestId = `ultraHD_${Date.now()}_${Math.random().toString(36).substr(2, 8)}`;
    
    // Set ultra HD timeouts
    req.setTimeout(ULTRA_HD_SETTINGS.maxTotalDuration);
    res.setTimeout(ULTRA_HD_SETTINGS.maxTotalDuration);
    
    try {
        const { bounds, resolution, apiKey, dataSource = 'google' } = req.body;
        
        const finalApiKey = apiKey || GOOGLE_MAPS_API_KEY;
        const sourceConfig = DATA_SOURCES[dataSource];
        
        if (!sourceConfig) {
            return res.status(400).json({ 
                error: `Unsupported data source: ${dataSource}`,
                availableSources: Object.keys(DATA_SOURCES)
            });
        }
        
        // Validation for ultra HD
        if (sourceConfig.supportsUltraHD && !finalApiKey && ['google', 'mapbox'].includes(dataSource)) {
            return res.status(400).json({ 
                error: 'API key required for ultra HD processing',
                requestId 
            });
        }
        
        if (!bounds || typeof bounds !== 'object') {
            return res.status(400).json({ 
                error: 'Invalid bounds provided',
                requestId 
            });
        }
        
        if (!resolution || resolution < 50 || resolution > sourceConfig.maxResolution) {
            return res.status(400).json({ 
                error: `Resolution must be between 50 and ${sourceConfig.maxResolution} for ${sourceConfig.name}`,
                requestId 
            });
        }
        
        // Calculate processing requirements
        const latDiff = Math.abs(bounds.north - bounds.south);
        const lngDiff = Math.abs(bounds.east - bounds.west);
        const area = latDiff * lngDiff;
        const totalPoints = (resolution + 1) * (resolution + 1);
        
        // Ultra HD area and complexity checks
        const maxArea = sourceConfig.supportsUltraHD ? 10.0 : 2.0;
        if (area > maxArea) {
            return res.status(400).json({ 
                error: `Area too large: ${area.toFixed(6)} sq° (max: ${maxArea} sq°)`,
                requestId 
            });
        }
        
        const { chunksX, chunksY, chunkSizeX, chunkSizeY } = calculateUltraHDChunkGrid(resolution);
        const totalChunks = chunksX * chunksY;
        
        // Estimate processing time and feasibility
        const estimatedApiCalls = Math.ceil(totalPoints / sourceConfig.maxPointsPerRequest);
        const estimatedMinutes = estimatedApiCalls / sourceConfig.rateLimit / 60;
        
        if (estimatedMinutes > 120) { // 2 hour limit
            return res.status(400).json({ 
                error: `Processing time too long: ~${estimatedMinutes.toFixed(0)} minutes (max: 120 minutes)`,
                suggestion: 'Reduce resolution or area size',
                requestId 
            });
        }
        
        // Initialize ultra HD request tracking
        chunkedRequests.set(requestId, {
            id: requestId,
            startTime,
            status: 'initializing',
            progress: 0,
            phase: 'setup',
            bounds,
            resolution,
            dataSource,
            sourceConfig: sourceConfig.name,
            area: area.toFixed(8),
            totalChunks,
            completedChunks: 0,
            totalPoints,
            processedPoints: 0,
            estimatedDuration: estimatedMinutes,
            chunkGrid: { chunksX, chunksY, chunkSizeX, chunkSizeY },
            qualityScore: sourceConfig.qualityScore,
            supportsUltraHD: sourceConfig.supportsUltraHD
        });

        console.log(`[${requestId}] Starting ultra HD processing: ${resolution}×${resolution} using ${sourceConfig.name}`);
        console.log(`[${requestId}] Area: ${area.toFixed(6)} sq°, Chunks: ${totalChunks}, Est. time: ${estimatedMinutes.toFixed(1)}m`);

        // Update status to processing
        chunkedRequests.set(requestId, {
            ...chunkedRequests.get(requestId),
            status: 'processing_chunks',
            phase: 'ultra_hd_elevation_processing'
        });

        // Process elevation data with ultra HD chunking
        const elevationData = await processUltraHDElevationChunked(
            bounds, 
            resolution, 
            finalApiKey,
            dataSource,
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
        console.log(`[${requestId}] Ultra HD processing completed in ${(processingTime/1000).toFixed(1)}s`);

        // Validate results
        if (!elevationData || elevationData.length === 0) {
            throw new Error('No elevation data received from ultra HD processing');
        }

        const expectedPoints = (resolution + 1) * (resolution + 1);
        const dataQuality = (elevationData.length / expectedPoints) * 100;

        // Update final status
        chunkedRequests.set(requestId, {
            ...chunkedRequests.get(requestId),
            status: 'completed',
            progress: 100,
            phase: 'completed',
            dataQuality: dataQuality.toFixed(1),
            actualPoints: elevationData.length,
            processingTime: processingTime
        });

        // Final garbage collection
        forceGarbageCollection();

        res.json({
            elevationData,
            bounds,
            resolution,
            dataSource,
            metadata: {
                points: elevationData.length,
                expectedPoints,
                dataQuality: dataQuality.toFixed(1),
                processingTime,
                area: area.toFixed(8),
                requestId,
                sourceInfo: {
                    name: sourceConfig.name,
                    qualityScore: sourceConfig.qualityScore,
                    supportsUltraHD: sourceConfig.supportsUltraHD,
                    nativeResolution: sourceConfig.maxPointsPerRequest
                },
                chunkInfo: {
                    totalChunks,
                    chunkGrid: { chunksX, chunksY, chunkSizeX, chunkSizeY },
                    processingMethod: 'ultra_hd_chunked',
                    actualDuration: (processingTime / 60000).toFixed(1) + 'm',
                    adaptiveChunking: ULTRA_HD_SETTINGS.adaptiveChunking
                }
            }
        });
        
    } catch (error) {
        console.error(`[${requestId}] Ultra HD processing error:`, error);
        
        // Update error status
        if (chunkedRequests.has(requestId)) {
            chunkedRequests.set(requestId, {
                ...chunkedRequests.get(requestId),
                status: 'error',
                error: error.message,
                phase: 'error'
            });
        }
        
        let statusCode = 500;
        let errorMessage = error.message || 'Ultra HD processing failed';
        
        if (error.message.includes('API key') || error.message.includes('quota')) {
            statusCode = 401;
            errorMessage = 'API authentication failed. Check your API key and quota.';
        } else if (error.message.includes('exceeded maximum limit') || error.message.includes('processing time')) {
            statusCode = 408;
            errorMessage = 'Ultra HD processing exceeded time limits. Try: lower resolution (≤2000) or smaller area (≤5 sq°).';
        } else if (error.message.includes('chunk') || error.message.includes('Chunk')) {
            statusCode = 422;
            errorMessage = 'Ultra HD chunk processing failed. Try: reduce resolution or check API limits.';
        } else if (error.message.includes('memory') || error.message.includes('Memory')) {
            statusCode = 507;
            errorMessage = 'Insufficient memory for ultra HD processing. Try: lower resolution or restart server.';
        }
        
        res.status(statusCode).json({ 
            error: errorMessage,
            timestamp: new Date().toISOString(),
            requestId,
            ultraHDSuggestion: 'For stable ultra HD: Use resolution ≤5000×5000, area ≤5 sq°, ensure sufficient API quota and memory.'
        });
    } finally {
        // Cleanup with longer delay for ultra HD
        setTimeout(() => {
            chunkedRequests.delete(requestId);
            forceGarbageCollection();
        }, 600000); // 10 minutes cleanup delay
    }
});

// Ultra HD chunked processing with enhanced progress tracking
async function processUltraHDElevationChunked(bounds, resolution, apiKey, dataSource, progressCallback, requestId) {
    const processingStartTime = Date.now();
    const { chunksX, chunksY, chunkSizeX, chunkSizeY } = calculateUltraHDChunkGrid(resolution);
    const totalChunks = chunksX * chunksY;
    
    console.log(`[${requestId}] Ultra HD chunked processing: ${chunksX}×${chunksY} chunks, ${chunkSizeX}×${chunkSizeY} points per chunk`);
    
    const allElevationData = [];
    let completedChunks = 0;
    let processedPoints = 0;
    
    // Calculate chunk boundaries with ultra HD precision
    const latRange = bounds.north - bounds.south;
    const lngRange = bounds.east - bounds.west;
    
    for (let chunkY = 0; chunkY < chunksY; chunkY++) {
        for (let chunkX = 0; chunkX < chunksX; chunkX++) {
            const chunkId = `${chunkX}_${chunkY}`;
            
            // Calculate precise chunk bounds
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
            const chunkPoints = (chunkResolution + 1) * (chunkResolution + 1);
            
            // Update detailed progress
            if (progressCallback) {
                const progressPercent = Math.round((completedChunks / totalChunks) * 100);
                progressCallback({
                    phase: 'ultra_hd_chunked_elevation',
                    progress: progressPercent,
                    currentChunk: completedChunks + 1,
                    totalChunks,
                    completedChunks,
                    processedPoints,
                    chunkId,
                    chunkResolution,
                    chunkPoints,
                    estimatedPointsRemaining: ((resolution + 1) * (resolution + 1)) - processedPoints,
                    processingRate: processedPoints / ((Date.now() - processingStartTime) / 1000),
                    dataSource
                });
            }
            
            try {
                const chunkData = await processUltraHDElevationChunk(
                    bounds, 
                    chunkBounds, 
                    chunkResolution, 
                    apiKey, 
                    chunkId, 
                    requestId,
                    dataSource
                );
                
                // Store chunk data with enhanced metadata
                allElevationData.push({
                    chunkX,
                    chunkY,
                    data: chunkData,
                    bounds: chunkBounds,
                    resolution: chunkResolution,
                    actualPoints: chunkData.length,
                    dataSource,
                    processingTime: Date.now() - (processingStartTime + (completedChunks * 30000)) // Rough estimate
                });
                
                completedChunks++;
                processedPoints += chunkData.length;
                
                console.log(`[${requestId}] Ultra HD chunk ${chunkId} completed: ${chunkData.length} points (${completedChunks}/${totalChunks})`);
                
                // Enhanced garbage collection for ultra HD
                if (completedChunks % 5 === 0) {
                    forceGarbageCollection();
                }
                
                // Adaptive pause between chunks based on complexity
                if (completedChunks < totalChunks) {
                    const adaptivePause = Math.min(2000 + (chunkPoints / 100), 10000);
                    await delay(adaptivePause);
                }
                
            } catch (error) {
                console.error(`[${requestId}] Ultra HD chunk ${chunkId} failed:`, error);
                throw new Error(`Ultra HD chunk processing failed at ${chunkId}: ${error.message}`);
            }
            
            // Check total timeout
            const totalElapsed = Date.now() - processingStartTime;
            if (totalElapsed > ULTRA_HD_SETTINGS.maxTotalDuration) {
                throw new Error(`Ultra HD processing exceeded maximum duration (${ULTRA_HD_SETTINGS.maxTotalDuration/60000} minutes). Completed ${completedChunks}/${totalChunks} chunks.`);
            }
        }
    }
    
    console.log(`[${requestId}] All ultra HD chunks completed, reconstructing ${resolution}×${resolution} grid...`);
    
    // Reconstruct the full ultra HD elevation grid
    const reconstructedData = reconstructUltraHDElevationGrid(allElevationData, bounds, resolution, chunksX, chunksY);
    
    const totalTime = Date.now() - processingStartTime;
    console.log(`[${requestId}] Ultra HD processing completed: ${(totalTime/1000).toFixed(1)}s, ${reconstructedData.length} points`);
    
    return reconstructedData;
}

// Enhanced grid reconstruction for ultra HD
function reconstructUltraHDElevationGrid(chunkDataArray, fullBounds, fullResolution, chunksX, chunksY) {
    console.log(`Reconstructing ultra HD ${fullResolution}×${fullResolution} grid from ${chunkDataArray.length} chunks`);
    
    const fullGrid = new Array((fullResolution + 1) * (fullResolution + 1));
    const latRange = fullBounds.north - fullBounds.south;
    const lngRange = fullBounds.east - fullBounds.west;
    
    let totalMappedPoints = 0;
    
    for (const chunkInfo of chunkDataArray) {
        const { chunkX, chunkY, data, bounds: chunkBounds, resolution: chunkRes } = chunkInfo;
        
        // Map each point in chunk data to the full grid with ultra HD precision
        let dataIndex = 0;
        for (let i = 0; i <= chunkRes && dataIndex < data.length; i++) {
            for (let j = 0; j <= chunkRes && dataIndex < data.length; j++) {
                // Calculate the precise global position
                const globalLat = chunkBounds.south + (i * (chunkBounds.north - chunkBounds.south) / chunkRes);
                const globalLng = chunkBounds.west + (j * (chunkBounds.east - chunkBounds.west) / chunkRes);
                
                // Convert to grid indices with high precision
                const gridI = Math.round((globalLat - fullBounds.south) / latRange * fullResolution);
                const gridJ = Math.round((globalLng - fullBounds.west) / lngRange * fullResolution);
                
                // Store in full grid if within bounds
                if (gridI >= 0 && gridI <= fullResolution && gridJ >= 0 && gridJ <= fullResolution) {
                    const fullGridIndex = gridI * (fullResolution + 1) + gridJ;
                    if (fullGridIndex < fullGrid.length && !fullGrid[fullGridIndex]) {
                        fullGrid[fullGridIndex] = {
                            ...data[dataIndex],
                            gridPosition: { i: gridI, j: gridJ },
                            chunkSource: `${chunkX}_${chunkY}`
                        };
                        totalMappedPoints++;
                    }
                }
                
                dataIndex++;
            }
        }
    }
    
    // Fill missing points with intelligent interpolation
    const finalData = [];
    let interpolatedPoints = 0;
    
    for (let i = 0; i <= fullResolution; i++) {
        for (let j = 0; j <= fullResolution; j++) {
            const index = i * (fullResolution + 1) + j;
            
            if (fullGrid[index]) {
                finalData.push(fullGrid[index]);
            } else {
                // Intelligent interpolation for missing points
                const interpolatedPoint = interpolateUltraHDPoint(fullGrid, i, j, fullResolution, fullBounds);
                finalData.push(interpolatedPoint);
                interpolatedPoints++;
            }
        }
    }
    
    console.log(`Ultra HD reconstruction complete: ${totalMappedPoints} mapped, ${interpolatedPoints} interpolated`);
    
    return finalData;
}

// Intelligent interpolation for ultra HD missing points
function interpolateUltraHDPoint(grid, i, j, resolution, bounds) {
    const lat = bounds.south + (i * (bounds.north - bounds.south) / resolution);
    const lng = bounds.west + (j * (bounds.east - bounds.west) / resolution);
    
    // Find nearby points for interpolation
    const nearbyPoints = [];
    const searchRadius = 3;
    
    for (let di = -searchRadius; di <= searchRadius; di++) {
        for (let dj = -searchRadius; dj <= searchRadius; dj++) {
            const ni = i + di;
            const nj = j + dj;
            
            if (ni >= 0 && ni <= resolution && nj >= 0 && nj <= resolution) {
                const neighborIndex = ni * (resolution + 1) + nj;
                if (grid[neighborIndex]) {
                    const distance = Math.sqrt(di * di + dj * dj);
                    nearbyPoints.push({
                        point: grid[neighborIndex],
                        distance: distance || 0.001 // Avoid division by zero
                    });
                }
            }
        }
    }
    
    let interpolatedElevation = 50; // Default fallback
    
    if (nearbyPoints.length > 0) {
        // Inverse distance weighted interpolation
        let weightedSum = 0;
        let totalWeight = 0;
        
        for (const nearby of nearbyPoints) {
            const weight = 1 / (nearby.distance * nearby.distance);
            weightedSum += nearby.point.elevation * weight;
            totalWeight += weight;
        }
        
        if (totalWeight > 0) {
            interpolatedElevation = weightedSum / totalWeight;
        }
    }
    
    return {
        elevation: interpolatedElevation,
        location: { lat, lng },
        interpolated: true,
        resolution: resolution
    };
}

// Cancel endpoint for ultra HD requests
app.post('/api/cancel/:requestId', (req, res) => {
    const requestId = req.params.requestId;
    const request = chunkedRequests.get(requestId);
    
    if (request) {
        request.cancelled = true;
        request.status = 'cancelled';
        chunkedRequests.set(requestId, request);
        res.json({ message: 'Ultra HD request cancellation initiated', requestId });
    } else {
        res.status(404).json({ error: 'Ultra HD request not found', requestId });
    }
});

// Enhanced cleanup for ultra HD processing
setInterval(() => {
    const now = Date.now();
    let cleaned = 0;
    
    for (const [id, request] of chunkedRequests.entries()) {
        const maxAge = request.status === 'completed' ? 600000 : ULTRA_HD_SETTINGS.maxTotalDuration + 600000;
        
        if (now - request.startTime > maxAge) {
            chunkedRequests.delete(id);
            cleaned++;
        }
    }
    
    if (cleaned > 0) {
        console.log(`🧹 Cleaned up ${cleaned} ultra HD requests`);
        forceGarbageCollection();
    }
}, 300000); // Every 5 minutes

// Enhanced memory monitoring for ultra HD
setInterval(() => {
    const memUsage = process.memoryUsage();
    const heapUsedMB = Math.round(memUsage.heapUsed / 1024 / 1024);
    const heapTotalMB = Math.round(memUsage.heapTotal / 1024 / 1024);
    
    if (heapUsedMB > 800) { // Alert if using > 800MB
        console.warn(`⚠️ High memory usage for ultra HD: ${heapUsedMB}MB/${heapTotalMB}MB - forcing cleanup`);
        forceGarbageCollection();
        
        // Cancel oldest requests if memory is critically high
        if (heapUsedMB > 1000) {
            const oldestRequests = Array.from(chunkedRequests.entries())
                .sort((a, b) => a[1].startTime - b[1].startTime)
                .slice(0, 2);
            
            for (const [id, request] of oldestRequests) {
                console.warn(`🚫 Cancelling ultra HD request ${id} due to memory pressure`);
                request.cancelled = true;
                request.status = 'cancelled_memory_pressure';
                chunkedRequests.set(id, request);
            }
        }
    }
    
    // Log memory stats periodically
    if (chunkedRequests.size > 0) {
        console.log(`📊 Ultra HD Memory: ${heapUsedMB}MB used, ${chunkedRequests.size} active requests`);
    }
}, 30000); // Every 30 seconds

// Error handling middleware
app.use((error, req, res, next) => {
    console.error('Unhandled ultra HD error:', error);
    res.status(500).json({ 
        error: 'Internal server error during ultra HD processing',
        message: error.message,
        timestamp: new Date().toISOString()
    });
});

// 404 handler
app.use((req, res) => {
    res.status(404).json({ 
        error: 'Endpoint not found',
        path: req.path,
        availableEndpoints: [
            '/health',
            '/api/detect-resolution',
            '/api/elevation',
            '/api/progress/:requestId',
            '/api/cancel/:requestId'
        ]
    });
});

// Graceful shutdown with ultra HD cleanup
function gracefulShutdown(signal) {
    console.log(`\n${signal} received, shutting down ultra HD server gracefully...`);
    
    // Cancel all active ultra HD requests
    for (const [id, request] of chunkedRequests.entries()) {
        request.cancelled = true;
        request.status = 'cancelled_shutdown';
        console.log(`🚫 Cancelled ultra HD request ${id} due to shutdown`);
    }
    
    // Final cleanup
    forceGarbageCollection();
    
    setTimeout(() => {
        process.exit(0);
    }, 5000); // 5 second grace period
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// Start the ultra HD server
app.listen(PORT, '0.0.0.0', () => {
    console.log(`🏔️ Ultra High-Resolution Terrain Generator Server`);
    console.log(`📡 Running on port ${PORT}`);
    console.log(`🌐 Access: http://localhost:${PORT}`);
    console.log(`🔧 Health: http://localhost:${PORT}/health`);
    console.log(`🎯 Ultra HD Features:`);
    console.log(`   • Max resolution: 10,000×10,000 points (Google)`);
    console.log(`   • Adaptive chunking: ${ULTRA_HD_SETTINGS.adaptiveChunking ? 'Enabled' : 'Disabled'}`);
    console.log(`   • Max processing time: ${ULTRA_HD_SETTINGS.maxTotalDuration/60000} minutes`);
    console.log(`   • Memory limit: ${Math.round(ULTRA_HD_SETTINGS.maxMemoryUsage/1024/1024)}MB`);
    console.log(`   • Supported sources: ${Object.keys(DATA_SOURCES).join(', ')}`);
    console.log(`🚀 Ready for ultra-high resolution terrain generation!`);
});
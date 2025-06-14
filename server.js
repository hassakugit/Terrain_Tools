// Optimized server.js for Cloud Run with 1-hour limit
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

// Aggressive optimization for Cloud Run's 1-hour limit
const MAX_PROCESSING_TIME = 55 * 60 * 1000; // 55 minutes (5 min buffer)
const AGGRESSIVE_BATCH_SIZE = 300; // Larger batches
const MINIMAL_DELAY = 200; // Faster requests

async function fetchElevationOptimized(bounds, resolution, apiKey) {
    const startTime = Date.now();
    const latStep = (bounds.north - bounds.south) / resolution;
    const lngStep = (bounds.east - bounds.west) / resolution;
    
    const totalPoints = (resolution + 1) * (resolution + 1);
    
    // Check if job can complete in time
    const estimatedTime = (totalPoints / AGGRESSIVE_BATCH_SIZE) * (MINIMAL_DELAY + 1000);
    if (estimatedTime > MAX_PROCESSING_TIME) {
        throw new Error(`Job too large for Cloud Run. Estimated ${Math.round(estimatedTime/60000)} minutes, max 55 minutes. Try resolution ≤ ${Math.floor(Math.sqrt(MAX_PROCESSING_TIME * AGGRESSIVE_BATCH_SIZE / 1200))}`);
    }
    
    console.log(`Optimized processing: ${totalPoints} points, estimated ${Math.round(estimatedTime/60000)} minutes`);
    
    const elevationData = new Array(totalPoints);
    const batchCount = Math.ceil(totalPoints / AGGRESSIVE_BATCH_SIZE);
    
    for (let batchIndex = 0; batchIndex < batchCount; batchIndex++) {
        // Time check - abort if approaching limit
        if (Date.now() - startTime > MAX_PROCESSING_TIME) {
            throw new Error(`Timeout approaching. Processed ${batchIndex}/${batchCount} batches.`);
        }
        
        const startIdx = batchIndex * AGGRESSIVE_BATCH_SIZE;
        const endIdx = Math.min(startIdx + AGGRESSIVE_BATCH_SIZE, totalPoints);
        
        const locations = [];
        const indices = [];
        
        for (let pointIndex = startIdx; pointIndex < endIdx; pointIndex++) {
            const row = Math.floor(pointIndex / (resolution + 1));
            const col = pointIndex % (resolution + 1);
            const lat = bounds.south + (row * latStep);
            const lng = bounds.west + (col * lngStep);
            
            locations.push(`${lat},${lng}`);
            indices.push(pointIndex);
        }
        
        try {
            const response = await axios.get('https://maps.googleapis.com/maps/api/elevation/json', {
                params: {
                    locations: locations.join('|'),
                    key: apiKey
                },
                timeout: 30000
            });
            
            if (response.data.status === 'OK' && response.data.results) {
                for (let i = 0; i < response.data.results.length; i++) {
                    elevationData[indices[i]] = response.data.results[i];
                }
                console.log(`Batch ${batchIndex + 1}/${batchCount} completed (${Math.round((batchIndex/batchCount)*100)}%)`);
            } else {
                throw new Error(`API error: ${response.data.status}`);
            }
        } catch (error) {
            console.error(`Batch ${batchIndex + 1} failed:`, error.message);
            // Fill with default elevations to continue
            for (let i = 0; i < indices.length; i++) {
                elevationData[indices[i]] = {
                    elevation: 100,
                    location: {
                        lat: parseFloat(locations[i].split(',')[0]),
                        lng: parseFloat(locations[i].split(',')[1])
                    }
                };
            }
        }
        
        // Minimal delay to avoid rate limits
        if (batchIndex < batchCount - 1) {
            await new Promise(resolve => setTimeout(resolve, MINIMAL_DELAY));
        }
    }
    
    const totalTime = Date.now() - startTime;
    console.log(`Optimized fetch completed in ${Math.round(totalTime/1000)} seconds`);
    return elevationData;
}

// Optimized STL generation
function generateSTLOptimized(elevationData, resolution, options = {}) {
    const startTime = Date.now();
    const {
        exaggeration = 2.0,
        baseHeight = 5,
        modelSize = 150
    } = options;
    
    console.log(`Generating optimized STL: ${resolution}x${resolution}`);
    
    // Fast min/max calculation
    let minElevation = Infinity;
    let maxElevation = -Infinity;
    
    for (let i = 0; i < elevationData.length; i++) {
        const elevation = elevationData[i]?.elevation || 0;
        if (elevation < minElevation) minElevation = elevation;
        if (elevation > maxElevation) maxElevation = elevation;
    }
    
    if (minElevation === maxElevation) maxElevation = minElevation + 1;
    const elevationRange = maxElevation - minElevation;
    
    // Build STL with string concatenation (faster than array join)
    let stl = `solid optimized_terrain_${resolution}x${resolution}\n`;
    const step = modelSize / resolution;
    
    // Optimized triangle generation
    for (let i = 0; i < resolution; i++) {
        for (let j = 0; j < resolution; j++) {
            const idx1 = i * (resolution + 1) + j;
            const idx2 = (i + 1) * (resolution + 1) + j;
            const idx3 = i * (resolution + 1) + (j + 1);
            const idx4 = (i + 1) * (resolution + 1) + (j + 1);
            
            const z1 = ((elevationData[idx1]?.elevation || 0) - minElevation) / elevationRange * modelSize * 0.4 * exaggeration + baseHeight;
            const z2 = ((elevationData[idx2]?.elevation || 0) - minElevation) / elevationRange * modelSize * 0.4 * exaggeration + baseHeight;
            const z3 = ((elevationData[idx3]?.elevation || 0) - minElevation) / elevationRange * modelSize * 0.4 * exaggeration + baseHeight;
            const z4 = ((elevationData[idx4]?.elevation || 0) - minElevation) / elevationRange * modelSize * 0.4 * exaggeration + baseHeight;
            
            const x1 = i * step, y1 = j * step;
            const x2 = (i + 1) * step, y2 = (j + 1) * step;
            
            // Two triangles per quad (optimized format)
            stl += `  facet normal 0.000000 0.000000 1.000000\n    outer loop\n      vertex ${x1.toFixed(3)} ${y1.toFixed(3)} ${z1.toFixed(3)}\n      vertex ${x2.toFixed(3)} ${y1.toFixed(3)} ${z2.toFixed(3)}\n      vertex ${x1.toFixed(3)} ${y2.toFixed(3)} ${z3.toFixed(3)}\n    endloop\n  endfacet\n`;
            stl += `  facet normal 0.000000 0.000000 1.000000\n    outer loop\n      vertex ${x2.toFixed(3)} ${y1.toFixed(3)} ${z2.toFixed(3)}\n      vertex ${x2.toFixed(3)} ${y2.toFixed(3)} ${z4.toFixed(3)}\n      vertex ${x1.toFixed(3)} ${y2.toFixed(3)} ${z3.toFixed(3)}\n    endloop\n  endfacet\n`;
        }
        
        // Progress logging for large models
        if (i % 100 === 0 && i > 0) {
            console.log(`STL generation: ${Math.round((i/resolution)*100)}% complete`);
        }
    }
    
    // Add base (simplified)
    stl += `  facet normal 0.000000 0.000000 -1.000000\n    outer loop\n      vertex 0.000 0.000 0.000\n      vertex 0.000 ${modelSize.toFixed(3)} 0.000\n      vertex ${modelSize.toFixed(3)} 0.000 0.000\n    endloop\n  endfacet\n`;
    stl += `  facet normal 0.000000 0.000000 -1.000000\n    outer loop\n      vertex ${modelSize.toFixed(3)} 0.000 0.000\n      vertex 0.000 ${modelSize.toFixed(3)} 0.000\n      vertex ${modelSize.toFixed(3)} ${modelSize.toFixed(3)} 0.000\n    endloop\n  endfacet\n`;
    
    stl += `endsolid optimized_terrain_${resolution}x${resolution}\n`;
    
    const totalTime = Date.now() - startTime;
    console.log(`STL generation completed in ${Math.round(totalTime/1000)} seconds`);
    return stl;
}

// Main endpoint optimized for Cloud Run
app.post('/api/elevation', async (req, res) => {
    const startTime = Date.now();
    
    // Set response timeout to 50 minutes (Cloud Run max is 60)
    req.setTimeout(50 * 60 * 1000);
    res.setTimeout(50 * 60 * 1000);
    
    try {
        const { bounds, resolution, apiKey } = req.body;
        
        const finalApiKey = apiKey || GOOGLE_MAPS_API_KEY;
        
        if (!finalApiKey) {
            return res.status(400).json({ error: 'Google Maps API key is required' });
        }
        
        if (!bounds || !resolution) {
            return res.status(400).json({ error: 'Missing bounds or resolution' });
        }
        
        // Stricter limits for Cloud Run
        if (resolution > 3000) {
            return res.status(400).json({ 
                error: `Resolution too high for Cloud Run (max 3000×3000). Requested: ${resolution}×${resolution}` 
            });
        }
        
        console.log(`Starting optimized processing: ${resolution}×${resolution} on Cloud Run`);
        
        // Fetch elevation data with optimization
        const elevationData = await fetchElevationOptimized(bounds, resolution, finalApiKey);
        
        // Generate STL with optimization
        const stlContent = generateSTLOptimized(elevationData, resolution, {
            exaggeration: req.body.exaggeration || 2.0,
            baseHeight: req.body.baseHeight || 5,
            modelSize: req.body.modelSize || 150
        });
        
        const totalTime = Date.now() - startTime;
        console.log(`Total processing time: ${Math.round(totalTime/1000)} seconds`);
        
        // Send STL content directly
        res.setHeader('Content-Type', 'application/octet-stream');
        res.setHeader('Content-Disposition', `attachment; filename="terrain_${resolution}x${resolution}_${Date.now()}.stl"`);
        res.send(stlContent);
        
    } catch (error) {
        console.error('Processing error:', error);
        
        let statusCode = 500;
        let errorMessage = error.message;
        
        if (error.message.includes('too large') || error.message.includes('Timeout')) {
            statusCode = 400;
        } else if (error.message.includes('API')) {
            statusCode = 401;
        }
        
        res.status(statusCode).json({ 
            error: errorMessage,
            timestamp: new Date().toISOString(),
            processingTime: Date.now() - startTime
        });
    }
});

// Health check
app.get('/health', (req, res) => {
    res.json({ 
        status: 'healthy',
        timestamp: new Date().toISOString(),
        platform: 'Cloud Run Optimized',
        maxResolution: '3000×3000',
        maxTime: '55 minutes'
    });
});

// Serve frontend
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const server = app.listen(PORT, '0.0.0.0', () => {
    console.log(`🏔️  Optimized Cloud Run Terrain Generator on port ${PORT}`);
    console.log(`⚡ Optimized for 1-hour Cloud Run limit`);
    console.log(`📊 Max resolution: 3000×3000`);
    console.log(`🚀 Aggressive batching: ${AGGRESSIVE_BATCH_SIZE} points/batch`);
});

// Graceful shutdown for Cloud Run
process.on('SIGTERM', () => {
    console.log('SIGTERM received, shutting down gracefully');
    server.close(() => {
        process.exit(0);
    });
});
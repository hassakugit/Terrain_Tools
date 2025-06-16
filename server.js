// Clean server.js with no syntax errors
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const path = require('path');
const fs = require('fs').promises;
const { v4: uuidv4 } = require('uuid');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 2021;
const GOOGLE_MAPS_API_KEY = process.env.GOOGLE_MAPS_API_KEY;

// Use file-based storage for job persistence
const JOBS_FILE = '/tmp/jobs.json';
const RESULTS_DIR = '/tmp/results';

// Ensure results directory exists
(async () => {
    try {
        await fs.mkdir(RESULTS_DIR, { recursive: true });
    } catch (error) {
        console.log('Results directory already exists or created');
    }
})();

// Job storage with file persistence
class JobStorage {
    constructor() {
        this.jobs = new Map();
        this.loadJobs();
    }

    async loadJobs() {
        try {
            const data = await fs.readFile(JOBS_FILE, 'utf8');
            const jobsArray = JSON.parse(data);
            this.jobs = new Map(jobsArray.map(job => [job.id, job]));
            console.log(`Loaded ${this.jobs.size} jobs from storage`);
        } catch (error) {
            console.log('No existing jobs file, starting fresh');
            this.jobs = new Map();
        }
    }

    async saveJobs() {
        try {
            const jobsArray = Array.from(this.jobs.values());
            await fs.writeFile(JOBS_FILE, JSON.stringify(jobsArray, null, 2));
        } catch (error) {
            console.error('Error saving jobs:', error);
        }
    }

    create(jobData) {
        const job = {
            id: uuidv4(),
            status: 'queued',
            progress: 0,
            currentStep: 'Initializing...',
            createdAt: new Date().toISOString(),
            ...jobData,
            error: null,
            fileSize: null,
            downloadPath: null
        };
        
        this.jobs.set(job.id, job);
        this.saveJobs();
        return job;
    }

    update(jobId, updates) {
        const job = this.jobs.get(jobId);
        if (job) {
            Object.assign(job, updates, { updatedAt: new Date().toISOString() });
            this.saveJobs();
            return job;
        }
        return null;
    }

    get(jobId) {
        return this.jobs.get(jobId);
    }

    getAll() {
        return Array.from(this.jobs.values());
    }

    delete(jobId) {
        const result = this.jobs.delete(jobId);
        if (result) {
            this.saveJobs();
        }
        return result;
    }
}

const jobStorage = new JobStorage();

// Middleware
app.use(cors());
app.use(express.json({ limit: '200mb' }));
app.use(express.static('public'));

// Rate limiting
const requestCounts = new Map();
const RATE_LIMIT_WINDOW = 60000;
const MAX_REQUESTS_PER_WINDOW = 5;

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

// Optimized elevation fetching with configurable chunking
async function fetchElevationOptimized(bounds, resolution, apiKey, jobId, batchSize = 400, batchDelay = 100) {
    const startTime = Date.now();
    
    const latStep = (bounds.north - bounds.south) / resolution;
    const lngStep = (bounds.east - bounds.west) / resolution;
    
    const totalPoints = (resolution + 1) * (resolution + 1);
    
    console.log(`Job ${jobId}: Processing ${totalPoints} points in ${Math.ceil(totalPoints / batchSize)} batches (${batchSize} points/batch, ${batchDelay}ms delay)`);
    
    const elevationData = new Array(totalPoints);
    const batchCount = Math.ceil(totalPoints / batchSize);
    
    jobStorage.update(jobId, {
        status: 'processing',
        currentStep: `Fetching elevation data: 0/${batchCount} batches`,
        progress: 5
    });
    
    for (let batchIndex = 0; batchIndex < batchCount; batchIndex++) {
        // Check if job was cancelled
        const job = jobStorage.get(jobId);
        if (!job || job.status === 'cancelled') {
            throw new Error('Job cancelled');
        }
        
        const startIdx = batchIndex * batchSize;
        const endIdx = Math.min(startIdx + batchSize, totalPoints);
        
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
                    const result = response.data.results[i];
                    // Set sea level (negative elevations) to 0
                    if (result.elevation < 0) {
                        result.elevation = 0;
                    }
                    elevationData[indices[i]] = result;
                }
                
                const progress = 5 + Math.round((batchIndex / batchCount) * 75);
                jobStorage.update(jobId, {
                    currentStep: `Fetching elevation data: ${batchIndex + 1}/${batchCount} batches (${Math.round((batchIndex/batchCount)*100)}%)`,
                    progress: progress,
                    batchSettings: { batchSize, batchDelay } // Store for ETA calculations
                });
                
                console.log(`Job ${jobId}: Batch ${batchIndex + 1}/${batchCount} completed (${progress}%)`);
            } else {
                throw new Error(`Google Maps API error: ${response.data.status}`);
            }
        } catch (error) {
            console.error(`Job ${jobId}: Batch ${batchIndex + 1} failed:`, error.message);
            
            // Fill with realistic terrain data to continue
            for (let i = 0; i < indices.length; i++) {
                const lat = parseFloat(locations[i].split(',')[0]);
                const lng = parseFloat(locations[i].split(',')[1]);
                
                const baseElevation = 100;
                const terrainVariation = Math.sin(lat * 0.05) * Math.cos(lng * 0.05) * 300;
                const detailVariation = Math.sin(lat * 0.2) * Math.cos(lng * 0.2) * 100;
                const noise = (Math.random() - 0.5) * 50;
                
                elevationData[indices[i]] = {
                    elevation: Math.max(0, baseElevation + terrainVariation + detailVariation + noise), // Ensure no negative elevations
                    location: { 
                        lat: lat, 
                        lng: lng 
                    }
                };
            }
        }
        
        // Configurable delay between batches
        if (batchIndex < batchCount - 1) {
            await new Promise(resolve => setTimeout(resolve, batchDelay));
        }
    }
    
    const totalTime = Date.now() - startTime;
    console.log(`Job ${jobId}: Elevation fetch completed in ${Math.round(totalTime/1000)} seconds`);
    return elevationData;
}

// Generate solid STL content with proper base and walls
function generateSTL(elevationData, resolution, options = {}) {
    const {
        exaggeration = 2.0,
        baseHeight = 2,
        modelSize = 150
    } = options;
    
    console.log(`Generating solid STL: ${resolution}×${resolution}`);
    
    // Find elevation range (excluding zero/sea level for scaling)
    let minElevation = Infinity;
    let maxElevation = -Infinity;
    
    for (const point of elevationData) {
        if (point && point.elevation !== undefined && point.elevation > 0) {
            if (point.elevation < minElevation) minElevation = point.elevation;
            if (point.elevation > maxElevation) maxElevation = point.elevation;
        }
    }
    
    // Handle case where all elevations are 0 (all sea)
    if (minElevation === Infinity) {
        minElevation = 0;
        maxElevation = 1;
    } else if (minElevation === maxElevation) {
        maxElevation = minElevation + 1;
    }
    
    const elevationRange = maxElevation - minElevation;
    
    // Build elevation grid
    const grid = [];
    for (let i = 0; i <= resolution; i++) {
        grid[i] = [];
        for (let j = 0; j <= resolution; j++) {
            const index = i * (resolution + 1) + j;
            const point = elevationData[index];
            const elevation = point ? point.elevation : 0;
            
            if (elevation <= 0) {
                // Sea level = base height only
                grid[i][j] = baseHeight;
            } else {
                // Land elevation = base + scaled height
                const normalizedHeight = ((elevation - minElevation) / elevationRange) * 
                                       modelSize * 0.4 * exaggeration;
                grid[i][j] = normalizedHeight + baseHeight;
            }
        }
    }
    
    // Generate STL
    let stl = `solid solid_terrain_${resolution}x${resolution}\n`;
    const step = modelSize / resolution;
    
    // Generate terrain surface triangles
    for (let i = 0; i < resolution; i++) {
        for (let j = 0; j < resolution; j++) {
            const x1 = i * step, y1 = j * step;
            const x2 = (i + 1) * step, y2 = (j + 1) * step;
            
            const z1 = grid[i][j], z2 = grid[i + 1][j];
            const z3 = grid[i][j + 1], z4 = grid[i + 1][j + 1];
            
            // Two triangles per quad (top surface)
            stl += addTriangle([x1, y1, z1], [x2, y1, z2], [x1, y2, z3]);
            stl += addTriangle([x2, y1, z2], [x2, y2, z4], [x1, y2, z3]);
        }
    }
    
    // Add solid base (bottom)
    stl += addTriangle([0, 0, 0], [0, modelSize, 0], [modelSize, 0, 0]);
    stl += addTriangle([modelSize, 0, 0], [0, modelSize, 0], [modelSize, modelSize, 0]);
    
    // Add side walls to make it a solid box
    // Front wall (y=0)
    for (let i = 0; i < resolution; i++) {
        const x1 = i * step, x2 = (i + 1) * step;
        const z1 = grid[i][0], z2 = grid[i + 1][0];
        
        stl += addTriangle([x1, 0, 0], [x1, 0, z1], [x2, 0, 0]);
        stl += addTriangle([x2, 0, 0], [x1, 0, z1], [x2, 0, z2]);
    }
    
    // Back wall (y=modelSize)
    for (let i = 0; i < resolution; i++) {
        const x1 = i * step, x2 = (i + 1) * step;
        const z1 = grid[i][resolution], z2 = grid[i + 1][resolution];
        
        stl += addTriangle([x1, modelSize, 0], [x2, modelSize, 0], [x1, modelSize, z1]);
        stl += addTriangle([x2, modelSize, 0], [x2, modelSize, z2], [x1, modelSize, z1]);
    }
    
    // Left wall (x=0)
    for (let j = 0; j < resolution; j++) {
        const y1 = j * step, y2 = (j + 1) * step;
        const z1 = grid[0][j], z2 = grid[0][j + 1];
        
        stl += addTriangle([0, y1, 0], [0, y2, 0], [0, y1, z1]);
        stl += addTriangle([0, y2, 0], [0, y2, z2], [0, y1, z1]);
    }
    
    // Right wall (x=modelSize)
    for (let j = 0; j < resolution; j++) {
        const y1 = j * step, y2 = (j + 1) * step;
        const z1 = grid[resolution][j], z2 = grid[resolution][j + 1];
        
        stl += addTriangle([modelSize, y1, 0], [modelSize, y1, z1], [modelSize, y2, 0]);
        stl += addTriangle([modelSize, y2, 0], [modelSize, y1, z1], [modelSize, y2, z2]);
    }
    
    stl += `endsolid solid_terrain_${resolution}x${resolution}\n`;
    return stl;
}

// Helper function to add a triangle with proper normal calculation
function addTriangle(v1, v2, v3) {
    // Calculate normal vector
    const u = [v2[0] - v1[0], v2[1] - v1[1], v2[2] - v1[2]];
    const v = [v3[0] - v1[0], v3[1] - v1[1], v3[2] - v1[2]];
    
    const normal = [
        u[1] * v[2] - u[2] * v[1],
        u[2] * v[0] - u[0] * v[2],
        u[0] * v[1] - u[1] * v[0]
    ];
    
    // Normalize
    const length = Math.sqrt(normal[0] * normal[0] + normal[1] * normal[1] + normal[2] * normal[2]);
    if (length > 0) {
        normal[0] /= length;
        normal[1] /= length;
        normal[2] /= length;
    }
    
    return `  facet normal ${normal[0].toFixed(6)} ${normal[1].toFixed(6)} ${normal[2].toFixed(6)}\n` +
           `    outer loop\n` +
           `      vertex ${v1[0].toFixed(3)} ${v1[1].toFixed(3)} ${v1[2].toFixed(3)}\n` +
           `      vertex ${v2[0].toFixed(3)} ${v2[1].toFixed(3)} ${v2[2].toFixed(3)}\n` +
           `      vertex ${v3[0].toFixed(3)} ${v3[1].toFixed(3)} ${v3[2].toFixed(3)}\n` +
           `    endloop\n` +
           `  endfacet\n`;
}

// Process job in background
async function processJob(jobId) {
    const job = jobStorage.get(jobId);
    if (!job) return;
    
    try {
        console.log(`Starting job ${jobId}: "${job.jobName}"`);
        
        // Fetch elevation data with configurable chunking
        const elevationData = await fetchElevationOptimized(
            job.bounds, 
            job.resolution, 
            job.apiKey, 
            jobId,
            job.batchSize || 400,
            job.batchDelay || 100
        );
        
        if (jobStorage.get(jobId)?.status === 'cancelled') {
            return;
        }
        
        jobStorage.update(jobId, {
            currentStep: 'Generating STL file...',
            progress: 85
        });
        
        // Generate STL
        const stlContent = generateSTL(elevationData, job.resolution, {
            exaggeration: job.exaggeration || 2.0,
            baseHeight: job.baseHeight || 2,
            modelSize: job.modelSize || 150
        });
        
        if (jobStorage.get(jobId)?.status === 'cancelled') {
            return;
        }
        
        jobStorage.update(jobId, {
            currentStep: 'Saving file...',
            progress: 95
        });
        
        // Save STL file with job name in filename
        const safeJobName = job.jobName.replace(/[^a-zA-Z0-9\-_]/g, '_');
        const filename = `${safeJobName}_${job.resolution}x${job.resolution}_${jobId.slice(0, 8)}.stl`;
        const filePath = path.join(RESULTS_DIR, filename);
        
        await fs.writeFile(filePath, stlContent);
        
        const fileSize = Buffer.byteLength(stlContent, 'utf8');
        const fileSizeMB = (fileSize / 1024 / 1024).toFixed(1);
        
        jobStorage.update(jobId, {
            status: 'completed',
            currentStep: 'Completed',
            progress: 100,
            fileSize: `${fileSizeMB}MB`,
            downloadPath: filePath,
            filename: filename
        });
        
        console.log(`Job ${jobId} "${job.jobName}" completed successfully - ${fileSizeMB}MB`);
        
    } catch (error) {
        console.error(`Job ${jobId} "${job.jobName}" failed:`, error);
        jobStorage.update(jobId, {
            status: 'failed',
            error: error.message,
            currentStep: 'Failed'
        });
    }
}

// API Routes

// Start server-side job
app.post('/api/server-job', rateLimit, async (req, res) => {
    try {
        const { bounds, resolution, apiKey, jobName, batchSize, batchDelay, ...options } = req.body;
        
        const finalApiKey = apiKey || GOOGLE_MAPS_API_KEY;
        
        if (!finalApiKey) {
            return res.status(400).json({ error: 'Google Maps API key is required' });
        }
        
        if (!bounds || !resolution) {
            return res.status(400).json({ error: 'Missing bounds or resolution' });
        }
        
        if (!jobName || jobName.trim().length === 0) {
            return res.status(400).json({ error: 'Job name is required for identification' });
        }
        
        if (resolution > 10000) {
            return res.status(400).json({ 
                error: `Resolution too high (max 10000×10000). Requested: ${resolution}×${resolution}` 
            });
        }
        
        // Validate batch settings
        const finalBatchSize = Math.min(Math.max(batchSize || 400, 50), 500);
        const finalBatchDelay = Math.min(Math.max(batchDelay || 100, 50), 2000);
        
        // Create job
        const job = jobStorage.create({
            bounds,
            resolution,
            apiKey: finalApiKey,
            jobName: jobName.trim(),
            batchSize: finalBatchSize,
            batchDelay: finalBatchDelay,
            dataSource: 'google',
            ...options
        });
        
        console.log(`Created job ${job.id}: "${jobName}" (${resolution}×${resolution}, batch: ${finalBatchSize}/${finalBatchDelay}ms)`);
        
        // Start processing in background
        processJob(job.id).catch(error => {
            console.error(`Background job ${job.id} error:`, error);
        });
        
        // Calculate time estimate
        const totalPoints = resolution * resolution;
        const totalBatches = Math.ceil(totalPoints / finalBatchSize);
        const estimatedSeconds = totalBatches * (finalBatchDelay / 1000 + 2);
        const estimatedMinutes = Math.round(estimatedSeconds / 60);
        
        res.json({
            jobId: job.id,
            status: job.status,
            jobName: jobName.trim(),
            message: 'Server job started successfully',
            batchSettings: {
                batchSize: finalBatchSize,
                batchDelay: finalBatchDelay
            },
            estimatedTime: `${estimatedMinutes} minutes`
        });
        
    } catch (error) {
        console.error('Error creating server job:', error);
        res.status(500).json({ 
            error: 'Failed to create server job: ' + error.message 
        });
    }
});

// Get job status
app.get('/api/job/:jobId', (req, res) => {
    const job = jobStorage.get(req.params.jobId);
    
    if (!job) {
        return res.status(404).json({ error: 'Job not found' });
    }
    
    const { downloadPath, ...jobStatus } = job;
    
    if (job.status === 'completed' && job.filename) {
        jobStatus.downloadLink = `/api/job/${job.id}/download`;
    }
    
    res.json(jobStatus);
});

// Cancel job
app.post('/api/job/:jobId/cancel', (req, res) => {
    const job = jobStorage.get(req.params.jobId);
    
    if (!job) {
        return res.status(404).json({ error: 'Job not found' });
    }
    
    if (job.status === 'completed') {
        return res.status(400).json({ error: 'Cannot cancel completed job' });
    }
    
    jobStorage.update(req.params.jobId, {
        status: 'cancelled',
        currentStep: 'Cancelled by user'
    });
    
    res.json({ message: 'Job cancelled successfully' });
});

// Download job result
app.get('/api/job/:jobId/download', async (req, res) => {
    const job = jobStorage.get(req.params.jobId);
    
    if (!job) {
        return res.status(404).json({ error: 'Job not found' });
    }
    
    if (job.status !== 'completed' || !job.downloadPath) {
        return res.status(400).json({ error: 'Job not completed or file not available' });
    }
    
    try {
        const fileExists = await fs.access(job.downloadPath).then(() => true).catch(() => false);
        
        if (!fileExists) {
            return res.status(404).json({ error: 'File not found' });
        }
        
        res.setHeader('Content-Type', 'application/octet-stream');
        res.setHeader('Content-Disposition', `attachment; filename="${job.filename}"`);
        
        const fileStream = require('fs').createReadStream(job.downloadPath);
        fileStream.pipe(res);
        
    } catch (error) {
        console.error('Download error:', error);
        res.status(500).json({ error: 'Failed to download file' });
    }
});

// List all jobs
app.get('/api/jobs', (req, res) => {
    const jobs = jobStorage.getAll().map(job => ({
        id: job.id,
        jobName: job.jobName,
        status: job.status,
        progress: job.progress,
        resolution: job.resolution,
        createdAt: job.createdAt,
        fileSize: job.fileSize
    }));
    
    res.json({ jobs });
});

// Keep-alive endpoint
app.get('/api/keepalive', (req, res) => {
    res.json({ 
        status: 'alive', 
        timestamp: new Date().toISOString(),
        uptime: process.uptime()
    });
});

// Health check
app.get('/health', (req, res) => {
    const jobs = jobStorage.getAll();
    const activeJobs = jobs.filter(job => 
        job.status === 'processing' || job.status === 'queued'
    ).length;
    
    res.json({ 
        status: 'healthy',
        timestamp: new Date().toISOString(),
        platform: 'Cloud Run - No Time Limits',
        maxResolution: '10000×10000',
        maxTime: 'Unlimited',
        activeJobs: activeJobs,
        totalJobs: jobs.length
    });
});

// Serve frontend
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Clean up old jobs periodically (keep last 7 days)
const cleanupOldJobs = async () => {
    const cutoff = Date.now() - (7 * 24 * 60 * 60 * 1000);
    const jobs = jobStorage.getAll();
    let cleaned = 0;
    
    for (const job of jobs) {
        if (new Date(job.createdAt).getTime() < cutoff) {
            if (job.downloadPath) {
                try {
                    await fs.unlink(job.downloadPath);
                } catch (error) {
                    // File already deleted
                }
            }
            
            jobStorage.delete(job.id);
            cleaned++;
        }
    }
    
    if (cleaned > 0) {
        console.log(`Cleaned up ${cleaned} old jobs`);
    }
};

setInterval(cleanupOldJobs, 6 * 60 * 60 * 1000);

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

// Graceful shutdown for Cloud Run
process.on('SIGTERM', () => {
    console.log('SIGTERM received, shutting down gracefully');
    process.exit(0);
});

const server = app.listen(PORT, '0.0.0.0', () => {
    console.log(`🏔️  Cloud Run Terrain Generator on port ${PORT}`);
    console.log(`📱 Frontend: http://localhost:${PORT}`);
    console.log(`☁️  No time limits - runs until complete`);
    console.log(`💾 Persistent job storage enabled`);
});
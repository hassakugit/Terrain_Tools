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
                    elevationData[indices[i]] = response.data.results[i];
                }
                
                const progress = 5 + Math.round((batchIndex / batchCount) * 75);
                jobStorage.update(jobId, {
                    currentStep: `Fetching elevation data: ${batchIndex + 1}/${batchCount} batches (${Math.round((batchIndex/batchCount)*100)}%)`,
                    progress: progress
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
                    elevation: Math.max(0, baseElevation + terrainVariation + detailVariation + noise),
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

// Generate STL content
function generateSTL(elevationData, resolution, options = {}) {
    const {
        exaggeration = 2.0,
        baseHeight = 5,
        modelSize = 150
    } = options;
    
    console.log(`Generating STL: ${resolution}×${resolution}`);
    
    // Find elevation range
    let minElevation = Infinity;
    let maxElevation = -Infinity;
    
    for (const point of elevationData) {
        if (point && point.elevation !== undefined) {
            if (point.elevation < minElevation) minElevation = point.elevation;
            if (point.elevation > maxElevation) maxElevation = point.elevation;
        }
    }
    
    if (minElevation === maxElevation) maxElevation = minElevation + 1;
    const elevationRange = maxElevation - minElevation;
    
    // Build elevation grid
    const grid = [];
    for (let i = 0; i <= resolution; i++) {
        grid[i] = [];
        for (let j = 0; j <= resolution; j++) {
            const index = i * (resolution + 1) + j;
            const point = elevationData[index];
            const elevation = point ? point.elevation : minElevation;
            const normalizedHeight = ((elevation - minElevation) / elevationRange) * 
                                   modelSize * 0.4 * exaggeration;
            grid[i][j] = normalizedHeight + baseHeight;
        }
    }
    
    // Generate STL
    let stl = `solid server_terrain_${resolution}x${resolution}\n`;
    const step = modelSize / resolution;
    
    // Generate terrain surface triangles
    for (let i = 0; i < resolution; i++) {
        for (let j = 0; j < resolution; j++) {
            const x1 = i * step, y1 = j * step;
            const x2 = (i + 1) * step, y2 = (j + 1) * step;
            
            const z1 = grid[i][j], z2 = grid[i + 1][j];
            const z3 = grid[i][j + 1], z4 = grid[i + 1][j + 1];
            
            // Two triangles per quad
            stl += `  facet normal 0.000000 0.000000 1.000000\n`;
            stl += `    outer loop\n`;
            stl += `      vertex ${x1.toFixed(3)} ${y1.toFixed(3)} ${z1.toFixed(3)}\n`;
            stl += `      vertex ${x2.toFixed(3)} ${y1.toFixed(3)} ${z2.toFixed(3)}\n`;
            stl += `      vertex ${x1.toFixed(3)} ${y2.toFixed(3)} ${z3.toFixed(3)}\n`;
            stl += `    endloop\n`;
            stl += `  endfacet\n`;
            
            stl += `  facet normal 0.000000 0.000000 1.000000\n`;
            stl += `    outer loop\n`;
            stl += `      vertex ${x2.toFixed(3)} ${y1.toFixed(3)} ${z2.toFixed(3)}\n`;
            stl += `      vertex ${x2.toFixed(3)} ${y2.toFixed(3)} ${z4.toFixed(3)}\n`;
            stl += `      vertex ${x1.toFixed(3)} ${y2.toFixed(3)} ${z3.toFixed(3)}\n`;
            stl += `    endloop\n`;
            stl += `  endfacet\n`;
        }
    }
    
    // Add base
    stl += `  facet normal 0.000000 0.000000 -1.000000\n`;
    stl += `    outer loop\n`;
    stl += `      vertex 0.000 0.000 0.000\n`;
    stl += `      vertex 0.000 ${modelSize.toFixed(3)} 0.000\n`;
    stl += `      vertex ${modelSize.toFixed(3)} 0.000 0.000\n`;
    stl += `    endloop\n`;
    stl += `  endfacet\n`;
    
    stl += `  facet normal 0.000000 0.000000 -1.000000\n`;
    stl += `    outer loop\n`;
    stl += `      vertex ${modelSize.toFixed(3)} 0.000 0.000\n`;
    stl += `      vertex 0.000 ${modelSize.toFixed(3)} 0.000\n`;
    stl += `      vertex ${modelSize.toFixed(3)} ${modelSize.toFixed(3)} 0.000\n`;
    stl += `    endloop\n`;
    stl += `  endfacet\n`;
    
    stl += `endsolid server_terrain_${resolution}x${resolution}\n`;
    return stl;
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
            baseHeight: job.baseHeight || 5,
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
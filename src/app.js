import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import env from './config/env.js';
import cookieParser from 'cookie-parser';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

// Create media directory if it doesn't exist
const mediaDir = path.join(__dirname, 'media');
if (!fs.existsSync(mediaDir)) {
    fs.mkdirSync(mediaDir, { recursive: true });
}

// Middleware
app.use(cors());
app.use(cookieParser());
app.use(express.json());
app.use('/media', express.static(mediaDir));

// API version prefix
const API_PREFIX = '/api/v1';

// Function to register API routes (called after AdminJS setup)
export const registerApiRoutes = async (app) => {
    // Import routes (dynamic imports to ensure they load after admin)
      const { default: authRoutes } = await import('./modules/auth/auth.routes.js');
      const { default: homeRoutes } = await import('./modules/home/home.routes.js');
      const {default: membersRoutes} = await import('./modules/members/members.routes.js');
      const {default: workoutsRoutes} = await import('./modules/workouts/workouts.routes.js');
      const {default: reportRoutes} = await import('./modules/report/report.routes.js');
      const {default: feeRoutes} = await import('./modules/fees/fees.router.js');
    //   const { default: analyticsRoutes } = await import('./modules/analytics/analytics.routes.js');
    //   const { default: deepLinkRoutes } = await import('./modules/deep_link/deep_link.routes.js');

      // API Routes
      app.use(`${API_PREFIX}/auth`, authRoutes);
      app.use(`${API_PREFIX}/home`, homeRoutes);
      app.use(`${API_PREFIX}/members`, membersRoutes);
      app.use(`${API_PREFIX}/workouts`, workoutsRoutes);
      app.use(`${API_PREFIX}/report`, reportRoutes);
      app.use(`${API_PREFIX}/fees`, feeRoutes);
    //   app.use(`${API_PREFIX}/analytics`, analyticsRoutes);
    //   app.use(`/app`, deepLinkRoutes);

    // Health check endpoint
    app.get(`${API_PREFIX}/health`, (req, res) => {
        res.json({ status: 'ok', message: 'Club Fitness API is running' });
    });

    // 404 handler for API routes (must be after all route registrations)
    app.use(API_PREFIX, (req, res) => {
        res.status(404).json({ error: 'API endpoint not found' });
    });

    // Error handling middleware
    app.use((err, req, res, next) => {
        console.error('Error:', err);

        const statusCode = err.statusCode || 500;
        const message = err.message || 'Internal Server Error';

        res.status(statusCode).json({
            error: message,
            ...(env.NODE_ENV === 'development' && { stack: err.stack })
        });
    });
};

export default app;
import env from './config/env.js';
import app, { registerApiRoutes } from './app.js';
import setupAdmin from './config/admin.js';

const BASE_URL = env.BASE_URL || env.NODE_ENV === 'production' ? 'https://api.clubfitness.co.in' : `http://localhost:${env.PORT}`;

const main = async () => {
  try {
    console.log('🚀 Starting Club Fitness backend...');
    console.log(`📌 Environment: ${env.NODE_ENV || 'development'}`);
    app.set('trust proxy', 1);

    // Only setup AdminJS in development or when not on Vercel
    if (env.NODE_ENV !== 'production' || !process.env.VERCEL) {
      await setupAdmin(app);
      console.log('✅ AdminJS configured successfully');
    } else {
      console.log('⚠️  AdminJS disabled in production (Vercel deployment)');
    }

    // Register API routes
    await registerApiRoutes(app);
    console.log('✅ API routes registered successfully');

    // Start the server
    app.listen(env.PORT, "0.0.0.0", () => {
      console.log('\n✅ Server successfully started!');
      console.log(`🌐 API Server: ${BASE_URL}/api/v1`);
      if (env.NODE_ENV !== 'production' || !process.env.VERCEL) {
        console.log(`⚙️  Admin Panel: ${BASE_URL}/admin`);
      }
      console.log(`📊 Health Check: ${BASE_URL}/api/v1/health`);
      if(env.BASE_URL) {
        console.log('🌐 Public URL: ', env.BASE_URL);
      }
      console.log('\n📍 Available API Endpoints:');
      console.log('   - /api/v1/auth          - Authentication & User Profile');
      console.log('   - /api/v1/home          - Home Feed');
      console.log('   - /api/v1/cart          - Shopping Cart');
      console.log('   - /api/v1/categories    - Product Categories');
      console.log('   - /api/v1/coupons       - Discount Coupons');
      console.log('   - /api/v1/orders        - Order Management');
      console.log('   - /api/v1/payments      - Payment Processing');
      console.log('   - /api/v1/products      - Product Catalog');
      console.log('   - /api/v1/reviews       - Product Reviews');
      console.log('   - /api/v1/users         - User Management');
      console.log('   - /api/v1/wishlist      - User Wishlist');
      console.log('   - /api/v1/analytics     - Analytics');
      console.log('\n✨ Ready to accept requests!');
    });

    // Handle graceful shutdown
    process.on('SIGTERM', () => {
      console.log('\n⚠️  SIGTERM signal received: closing HTTP server');
      process.exit(0);
    });

    process.on('SIGINT', () => {
      console.log('\n⚠️  SIGINT signal received: closing HTTP server');
      process.exit(0);
    });

  } catch (error) {
    console.error('❌ Failed to start server:', error);
    process.exit(1);
  }
};

export default main;
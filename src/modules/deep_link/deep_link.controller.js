import path from 'path';
import Mustache from 'mustache';
import env from '../../config/env.js';
import { fileURLToPath } from 'url';
import { loadTemplate } from '../../utils/load-template.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Handle deep link redirection
 * Converts web URL to app deep link format
 * Example: /app/abc-route?id=132 -> club_fitness://open/abc-route?id=132
 */
const handleDeepLink = async (req, res, next) => {
  try {
    // Get the path after /app/ from the named parameter
    const deepLinkPath = req.params.path || '';

    // Get query parameters
    const queryString = Object.keys(req.query).length > 0
      ? '?' + new URLSearchParams(req.query).toString()
      : '';

    // Construct the deep link URL
    const appDeepLink = `clubfitness://open/${deepLinkPath}${queryString}`;

    // Load the HTML template
    const template = await loadTemplate('../../components/deeplink-template.html', __dirname);

    // Replace placeholders in template
    const html = Mustache.render(template, { 
      APP_NAME: 'Club Fitness',
      APP_DEEP_LINK: appDeepLink, 
      FALLBACK_URL: req.headers['user-agent']?.includes('iPhone') ? env.APP_STORE_URL || 'https://www.google.com' : env.PLAY_STORE_URL || 'https://www.google.com', 
      LOGO_URL: env.LOGO_URL 
    });
    // const html = template
    //   .replace('{{APP_DEEP_LINK}}', appDeepLink)
    //   .replace('{{FALLBACK_URL}}', process.env.APP_STORE_URL || 'https://totebags.com/download')
    //   .replace('{{APP_NAME}}', 'Totebags');

    // Set content type and send HTML
    res.setHeader('Content-Type', 'text/html');
    res.send(html);

  } catch (error) {
    next(error);
  }
};

export default {
  handleDeepLink
};
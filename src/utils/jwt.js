import jwt from 'jsonwebtoken';
import env from '../config/env.js';

const JWT_SECRET = env.JWT_SECRET || 'your-secret-key-change-in-production';
const ACCESS_TOKEN_EXPIRES_IN = '3h';
const REFRESH_TOKEN_EXPIRES_IN = '7d';
const ROTATION_TOKEN_EXPIRES_IN = '365d'; // 1 year, but can be invalidated

const generateAccessToken = (payload) => {
  return jwt.sign(
    { ...payload, type: 'access' },
    JWT_SECRET,
    { expiresIn: ACCESS_TOKEN_EXPIRES_IN }
  );
};

const generateRefreshToken = (payload) => {
  return jwt.sign(
    { ...payload, type: 'refresh' },
    JWT_SECRET,
    { expiresIn: REFRESH_TOKEN_EXPIRES_IN }
  );
};

const generateRotationToken = (payload) => {
  // Generate a unique token ID for blacklisting
  const tokenId = `${payload.id}_${Date.now()}_${Math.random().toString(36).substring(7)}`;
  return jwt.sign(
    { ...payload, type: 'rotation', tokenId },
    JWT_SECRET,
    { expiresIn: ROTATION_TOKEN_EXPIRES_IN }
  );
};

const generateTokenSet = (payload) => {
  const accessToken = generateAccessToken(payload);
  const refreshToken = generateRefreshToken(payload);
  const rotationToken = generateRotationToken(payload);
  
  return {
    accessToken,
    refreshToken,
    rotationToken
  };
};

const verifyToken = (token, expectedType = null) => {
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    
    if (expectedType && decoded.type !== expectedType) {
      throw new Error(`Invalid token type. Expected ${expectedType}, got ${decoded.type}`);
    }
    
    return decoded;
  } catch (error) {
    if (error.name === 'TokenExpiredError') {
      throw new Error('Token expired');
    }
    throw new Error('Invalid token');
  }
};

const decodeToken = (token) => {
  return jwt.decode(token);
};

export {
  generateAccessToken,
  generateRefreshToken,
  generateRotationToken,
  generateTokenSet,
  verifyToken,
  decodeToken
};
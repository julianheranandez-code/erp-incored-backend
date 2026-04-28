const swaggerJsdoc = require('swagger-jsdoc');

const options = {
  definition: {
    openapi: '3.0.0',
    info: {
      title: 'Incored ERP API',
      version: '1.0.0',
      description: 'Backend API para Incored ERP - Node.js + PostgreSQL',
    },
    servers: [
      {
        url: 'https://incored-api.onrender.com',
        description: 'Production API',
      },
      {
        url: 'http://localhost:5001',
        description: 'Development API',
      },
    ],
  },
  apis: ['./src/routes/*.js'],
};

module.exports = swaggerJsdoc(options);
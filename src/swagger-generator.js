const fs = require('fs');
const path = require('path');

// Lee todos los archivos de rutas
const routesDir = path.join(__dirname, 'routes');
const routeFiles = fs.readdirSync(routesDir).filter(f => f.endsWith('.js'));

routeFiles.forEach(file => {
  const filePath = path.join(routesDir, file);
  let content = fs.readFileSync(filePath, 'utf-8');
  
  // Detecta rutas y agrega documentación
  const routeRegex = /router\.(get|post|put|patch|delete)\(['"]([^'"]+)['"]/g;
  let match;
  
  const routeMap = new Map();
  while ((match = routeRegex.exec(content)) !== null) {
    const method = match[1].toUpperCase();
    const path = match[2];
    const tag = file.replace('.js', '').toUpperCase();
    
    routeMap.set(`${method} ${path}`, { method, path, tag });
  }
  
  console.log(`${file}: ${routeMap.size} rutas encontradas`);
  routeMap.forEach(route => {
    console.log(`  ${route.method} ${route.path}`);
  });
});
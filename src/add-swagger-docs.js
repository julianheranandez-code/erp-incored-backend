const fs = require('fs');
const path = require('path');

const routesDir = path.join(__dirname, 'routes');
const routeFiles = fs.readdirSync(routesDir).filter(f => f.endsWith('.js') && f !== 'index.js');

const tagMap = {
  'auth.js': 'Auth',
  'crm.js': 'CRM',
  'employees.js': 'Employees',
  'files.js': 'Files',
  'inventory.js': 'Inventory',
  'projects.js': 'Projects',
  'reports.js': 'Reports',
  'tasks.js': 'Tasks',
  'transactions.js': 'Transactions',
  'users.js': 'Users'
};

routeFiles.forEach(file => {
  const filePath = path.join(routesDir, file);
  let content = fs.readFileSync(filePath, 'utf-8');
  const tag = tagMap[file];
  
  // Reemplaza router.get/post/put/patch/delete con versión documentada
  const methods = ['get', 'post', 'put', 'patch', 'delete'];
  
  methods.forEach(method => {
    const regex = new RegExp(`router\\.${method}\\('([^']+)'`, 'g');
    content = content.replace(regex, (match, path) => {
      const summary = `${method.toUpperCase()} ${path}`;
      const swagger = `/**
 * @swagger
 * ${path}:
 *   ${method}:
 *     summary: ${summary}
 *     tags:
 *       - ${tag}
 *     responses:
 *       200:
 *         description: Success
 */
router.${method}('${path}'`;
      
      return swagger;
    });
  });
  
  fs.writeFileSync(filePath, content, 'utf-8');
  console.log(`✅ ${file} documentado`);
});

console.log('\\n✅ Todas las rutas documentadas con Swagger');
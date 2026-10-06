import { request } from 'node:http';
import { AgentError } from './errors.js';
export function adminRequest(socketPath: string, path: string, method = 'GET'): Promise<any> {
  return new Promise((resolve, reject) => {
    const req = request({ socketPath, path, method, timeout: 2000 }, response => {
      let data = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { data += chunk; if (data.length > 65536) req.destroy(new Error('Admin response too large')); });
      response.on('end', () => {
        if (response.statusCode !== 200) return reject(new AgentError('ADMIN_ERROR', 'Local daemon rejected the request.'));
        try { resolve(JSON.parse(data)); } catch (error) { reject(error); }
      });
    });
    req.on('timeout', () => req.destroy(new Error('Admin request timed out')));
    req.on('error', reject); req.end();
  });
}

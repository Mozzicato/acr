// Vercel function: every API route goes through here (/api/router?path=...).
import { handle } from '../server/router.js';

export async function GET(request: Request): Promise<Response> {
  return handle(request, process.env);
}

export async function POST(request: Request): Promise<Response> {
  return handle(request, process.env);
}

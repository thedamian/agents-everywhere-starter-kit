import { api } from "../../../../../server/api";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Context = { params: Promise<{ jobId: string }> };
export async function POST(request: Request, context: Context) { return api().cancelJob(request, (await context.params).jobId); }

import { api } from "../../../../server/api";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Context = { params: Promise<{ key: string }> };
export async function GET(request: Request, context: Context) { return api().getUploadBatch(request, (await context.params).key); }
export async function DELETE(request: Request, context: Context) { return api().deleteUploadBatch(request, (await context.params).key); }

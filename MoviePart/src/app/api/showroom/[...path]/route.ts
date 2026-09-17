import { showroomGateway } from "../../../../server/showroom-gateway";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function handle(request: Request) {
  return showroomGateway(request, {
    upstream: process.env.SHOWROOM_API_UPSTREAM,
    publicOrigin: process.env.SHOWROOM_PUBLIC_ORIGIN,
  });
}

export const GET = handle;
export const POST = handle;
export const HEAD = handle;
export const PUT = handle;
export const PATCH = handle;
export const DELETE = handle;
export const OPTIONS = handle;

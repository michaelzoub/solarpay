import { NextResponse } from "next/server";
import { resolveIntent } from "@/lib/store";

export async function POST(request: Request) {
  try {
    const body = await request.json();
    return NextResponse.json({ payment: resolveIntent(body.intentNonce, body.customerBadgeId) });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Payment rejected" }, { status: 400 });
  }
}
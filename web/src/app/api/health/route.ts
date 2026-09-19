import { NextResponse } from "next/server";

export function GET() {
  return NextResponse.json({ service: "solarpay", status: "ok", protocolVersion: 1 });
}

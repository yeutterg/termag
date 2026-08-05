import { NextResponse } from "next/server";
import { getCSRFTokenForClient } from "@/lib/csrf";

export async function GET() {
  try {
    const { token } = await getCSRFTokenForClient();
    return NextResponse.json({ token });
  } catch {
    return NextResponse.json({ error: "Failed to generate CSRF token" }, { status: 500 });
  }
}

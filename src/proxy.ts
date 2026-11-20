import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

import { isOperatorAuthorization, operatorChallenge } from "./lib/http/operator_auth";

/** Ask for the operator login before any operator page or API is rendered; each handler checks it again. */
export function proxy(request: NextRequest) {
	if (!isOperatorAuthorization(request.headers.get("authorization"))) return operatorChallenge();
	return NextResponse.next();
}

export const config = {
	matcher: ["/operator/:path*", "/api/operator/:path*"],
};

import { cookies } from "next/headers";

import {
    ADMIN_SESSION_COOKIE,
    verifyAdminSessionToken,
} from "@/lib/admin-auth";

export async function hasAdminSession() {
    const cookieStore = await cookies();

    const token = cookieStore.get(
        ADMIN_SESSION_COOKIE
    )?.value;

    return verifyAdminSessionToken(
        token
    );
}

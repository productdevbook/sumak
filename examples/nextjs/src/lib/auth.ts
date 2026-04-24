import { cookies } from "next/headers"

/**
 * Stand-in for real auth. In a real app this would verify a JWT /
 * session cookie; here we just read a `tid` cookie so the example
 * has a deterministic tenant scope without pulling an auth library.
 */
export async function currentTenantId(): Promise<number> {
  const cookieStore = await cookies()
  const tid = Number(cookieStore.get("tid")?.value ?? 1)
  return Number.isFinite(tid) ? tid : 1
}

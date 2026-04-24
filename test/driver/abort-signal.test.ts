import { describe, expect, it } from "vitest"

import { AbortError, isAbortError, withSignal } from "../../src/driver/types.ts"

describe("AbortError + isAbortError", () => {
  it("AbortError has name 'AbortError' and the default message", () => {
    const e = new AbortError()
    expect(e.name).toBe("AbortError")
    expect(e.message).toBe("The operation was aborted.")
  })

  it("isAbortError matches by name, regardless of constructor", () => {
    expect(isAbortError(new AbortError())).toBe(true)
    const mimic = new Error("...")
    mimic.name = "AbortError"
    expect(isAbortError(mimic)).toBe(true)
    expect(isAbortError(new TypeError("nope"))).toBe(false)
    expect(isAbortError("string-not-error")).toBe(false)
  })
})

describe("withSignal", () => {
  it("returns the task verbatim when no signal is passed", async () => {
    const r = await withSignal(undefined, Promise.resolve(42))
    expect(r).toBe(42)
  })

  it("throws AbortError synchronously-ish when the signal is already aborted", async () => {
    const ctrl = new AbortController()
    ctrl.abort()
    await expect(withSignal(ctrl.signal, Promise.resolve("never"))).rejects.toThrowError(
      /operation was aborted/i,
    )
  })

  it("aborting mid-flight rejects with AbortError even if the task would resolve", async () => {
    const ctrl = new AbortController()
    const slow = new Promise<string>((resolve) => setTimeout(() => resolve("done"), 50))
    const race = withSignal(ctrl.signal, slow)
    setTimeout(() => ctrl.abort(), 10)
    await expect(race).rejects.toSatisfy((err: unknown) => isAbortError(err))
  })

  it("calls onAbort exactly once when the signal fires", async () => {
    const ctrl = new AbortController()
    let count = 0
    const task = new Promise<void>((resolve) => setTimeout(resolve, 50))
    const race = withSignal(ctrl.signal, task, () => {
      count++
    })
    setTimeout(() => ctrl.abort(), 10)
    await expect(race).rejects.toThrow()
    expect(count).toBe(1)
  })

  it("onAbort runs even when the signal was already aborted at entry", async () => {
    const ctrl = new AbortController()
    ctrl.abort()
    let called = false
    await expect(
      withSignal(ctrl.signal, Promise.resolve("x"), () => {
        called = true
      }),
    ).rejects.toThrow()
    expect(called).toBe(true)
  })

  it("propagates non-abort rejections unchanged", async () => {
    const ctrl = new AbortController()
    const boom = new Error("original")
    await expect(withSignal(ctrl.signal, Promise.reject(boom))).rejects.toBe(boom)
  })
})

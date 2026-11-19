import { describe, expect, it } from "vitest"
import { portalPageOutlineFromSpec } from "./page-outline"

const FOLDER_ID = "00000000-0000-4000-8000-000000000001"

describe("portalPageOutlineFromSpec", () => {
  it("reads pages and Home's slot from a layout", () => {
    expect(
      portalPageOutlineFromSpec({
        homePosition: 1,
        pages: [
          { id: "p1", title: "API Reference", slug: "api-reference", scope: [FOLDER_ID] },
          {
            id: "p2",
            title: "Changelog",
            slug: "changelog",
            scope: null,
            presentation: "changelog",
          },
        ],
      }),
    ).toEqual({
      homePosition: 1,
      pages: [
        // The legacy api-reference slug reads as a reference page.
        {
          id: "p1",
          title: "API Reference",
          slug: "api-reference",
          scope: [FOLDER_ID],
          presentation: "api_reference",
        },
        {
          id: "p2",
          title: "Changelog",
          slug: "changelog",
          scope: null,
          presentation: "changelog",
        },
      ],
    })
  })

  it("skips a malformed page and clamps Home's slot to the pages kept", () => {
    expect(
      portalPageOutlineFromSpec({
        homePosition: 5,
        pages: [{ id: "p1", title: "", slug: "Bad Slug", scope: null }],
      }),
    ).toEqual({ homePosition: 0, pages: [] })
  })

  it("treats a missing layout as no pages", () => {
    expect(portalPageOutlineFromSpec(null)).toEqual({ homePosition: 0, pages: [] })
    expect(portalPageOutlineFromSpec({ pages: "nope" })).toEqual({
      homePosition: 0,
      pages: [],
    })
  })
})

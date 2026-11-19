import { redirect } from "next/navigation"

// OpenAPI specs now live on the GitHub integration page; keep old links working.
export default function OpenApiIntegrationRedirect(): never {
  redirect("/settings/integrations/github#openapi")
}

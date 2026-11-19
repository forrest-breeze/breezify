import { redirect } from "next/navigation";

// GitHub is the default integration page.
export default function IntegrationsIndex(): never {
  redirect("/settings/integrations/github");
}

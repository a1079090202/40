import { redirect } from "@remix-run/node";

export const loader = async () => redirect("/calendar");

export default function Index() {
  return null;
}

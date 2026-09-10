import { notFound, redirect } from "next/navigation";
import { currentUser } from "@/lib/auth";
import { listProjects } from "@/lib/runtime-projects";
import { NativeTerminal } from "@/components/native-terminal";

export const dynamic = "force-dynamic";

/** Cookie-authenticated surface for the SwiftUI client; never accepts native runtime ids. */
export default async function NativeTerminalPage({
  searchParams,
}: {
  searchParams: Promise<{ project?: string; tab?: string }>;
}) {
  const user = await currentUser();
  if (!user) {
    redirect("/login");
  }
  const query = await searchParams;
  const projects = await listProjects(user.id);
  const project = projects.find(item => item.id === query.project);
  const selected = project?.tabs.find(tab => tab.id === query.tab);
  if (!project || !selected?.session) {
    notFound();
  }
  const tabs = project.tabs.filter(tab =>
    selected.runtimeTabId ? tab.runtimeTabId === selected.runtimeTabId : tab.id === selected.id
  );
  return <NativeTerminal tabs={tabs} />;
}

import { BotIcon, FolderPlusIcon, GlobeIcon, HouseIcon } from "lucide-react";
import { machineIcon } from "../chrome/EnvBits";
import type { AttachedFile } from "../lib/blocks";
import type { AgentChoice } from "../lib/providers";
import { Fact, StarterCard as WayCard } from "./chat/SessionIntro";
import { StartScreen } from "./WorkspaceStart";

type Props = {
  /** No project is open yet: the page greets a new user and shows the way in. */
  firstRun: boolean;
  /** The Home folder, which `@` lists. */
  cwd: string | null;
  /** A new session in home, with `text` as its first message, in what the chips say. */
  onAsk: (text: string, choice: AgentChoice, files?: AttachedFile[]) => void;
  onOpenFolder: () => void;
  onNewBot: () => void;
  onOpenBrowser: () => void;
};

/**
 * Home with no tab open, laid out like a new session's first screen: a
 * composer in the middle of the page. What is sent starts a session in home's
 * folder with that message, in the model, effort and access the chips say; the
 * tab it opens is the session's, chat or terminal as Settings say. The chips
 * open on the last pick, and a pick here becomes it.
 */
export function HomeStart({ firstRun, cwd, onAsk, onOpenFolder, onNewBot, onOpenBrowser }: Props) {
  return (
    <StartScreen
      cwd={cwd}
      indexFiles={false}
      rememberPick
      title={firstRun ? "Welcome to Crew" : "What are we working on?"}
      facts={
        <>
          <Fact icon={HouseIcon} title="Runs in your Home folder">
            Home
          </Fact>
          <Fact icon={machineIcon(false)}>This Mac</Fact>
        </>
      }
      ways={
        <>
          <WayCard icon={FolderPlusIcon} title="Open a project folder" hint="Code, worktrees and commands" onClick={onOpenFolder} />
          <WayCard icon={BotIcon} title={firstRun ? "Meet your first bot" : "Make a bot"} hint="A named agent with its own history" onClick={onNewBot} />
          <WayCard icon={GlobeIcon} title="Open a browser tab" hint="Let agents browse, fill forms and capture pages" onClick={onOpenBrowser} />
        </>
      }
      onAsk={onAsk}
    />
  );
}

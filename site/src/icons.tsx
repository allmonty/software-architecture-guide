import { Activity, Bell, BookOpen, Blocks, BrainCircuit, Compass, Database, Film, Library, ListChecks, Map, MapPin, MessagesSquare, PencilRuler, Puzzle, Radio, Scale, Siren, Sparkles, Sprout, Target, type LucideIcon } from "lucide-react";

// Icons for tracks, learning stages and home sections. Colours come from the C4 palette in styles.css (.tone-*).
type Entry = [LucideIcon, string];
const TRACK: Record<string, Entry> = {
  interview: [MessagesSquare, "service"], foundations: [Blocks, "edge"], architect: [Compass, "data"], ai: [BrainCircuit, "client"], atlas: [Map, "queue"],
};
const NAMED: Record<string, Entry> = {
  "Foundations": [Sprout, "edge"], "Building blocks": [Puzzle, "service"], "Storage and data infrastructure": [Database, "data"],
  "Real-time communication": [Radio, "queue"], "Media delivery": [Film, "client"], "Feeds and notifications": [Bell, "service"],
  "Correctness under contention": [Scale, "data"], "Location and discovery": [MapPin, "edge"], "Data pipelines and observability": [Activity, "queue"],
  "AI systems": [Sparkles, "client"],
  "pick": [Target, "service"], "method": [ListChecks, "edge"], "browse": [Library, "data"],
  "Incident": [Siren, "queue"], "Primer": [BookOpen, "service"], "Exercise": [PencilRuler, "edge"],
};

function Tile({ entry, size }: { entry: Entry | undefined; size: "sm" | "md" }) {
  if (!entry) return null;
  const [Icon, tone] = entry;
  return <span className={`tile ${size} tone-${tone}`} aria-hidden="true"><Icon size={size === "md" ? 20 : 16} strokeWidth={2} /></span>;
}

export const TrackIcon = ({ id, size = "md" }: { id: string; size?: "sm" | "md" }) => <Tile entry={TRACK[id]} size={size} />;
export const NamedIcon = ({ name, size = "sm" }: { name: string; size?: "sm" | "md" }) => <Tile entry={NAMED[name]} size={size} />;

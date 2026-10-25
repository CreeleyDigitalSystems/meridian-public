import type { WorldConnection } from "../world/use-world.js";

const labels: Record<WorldConnection, string> = {
  live: "Live — verified",
  reconnecting: "Reconnecting — validating the world",
  "offline-stale": "Offline — last known view",
};

export function WorldStatus({ connection }: { connection: WorldConnection }) {
  return <p className={`connection connection--${connection}`} role="status">{labels[connection]}</p>;
}

import { randomInt } from "node:crypto";

// Keep these lists deliberately small and human-readable: the finite pair space keeps handles
// easy to read aloud and type.
const ADJECTIVES = [
  "amber", "ancient", "azure", "bold", "brave", "breezy", "bright", "brisk", "bubbly", "bucolic",
  "calm", "candid", "cheerful", "clear", "clever", "cloudy", "coastal", "cool", "cozy", "crafty",
  "crisp", "curious", "dainty", "daring", "dashing", "dappled", "devoted", "distant", "eager", "electric",
  "even", "fiery", "fleet", "fluffy", "fresh", "friendly", "frosty", "funny", "gentle", "giant",
  "gleaming", "glowing", "golden", "graceful", "happy", "hardy", "hidden", "hollow", "icy", "ivory",
  "jolly", "keen", "kind", "leafy", "lively", "local", "lucid", "lucky", "lunar", "magical",
  "mellow", "misty", "modest", "mossy", "musical", "noble", "nimble", "oceanic", "olive", "peaceful",
  "peachy", "playful", "plucky", "polished", "quiet", "radiant", "rapid", "rustic", "sage", "serene",
  "sharp", "silent", "silver", "sleepy", "smooth", "snowy", "solar", "steady", "stellar", "sunny",
  "swift", "tender", "tranquil", "vivid", "warm", "watchful", "wild", "wise", "witty", "zesty",
] as const;

const NOUNS = [
  "acorn", "antelope", "aster", "badger", "beaver", "birch", "bison", "blossom", "bluebird", "brook",
  "breeze", "canyon", "cardinal", "cedar", "cherry", "clover", "cloud", "comet", "coral", "coyote",
  "crane", "creek", "dahlia", "dandelion", "dolphin", "dragon", "dusk", "eagle", "ember", "falcon",
  "fern", "finch", "firefly", "forest", "fox", "galaxy", "garden", "geode", "glacier", "grove",
  "harbor", "hawk", "heron", "hill", "hummingbird", "iris", "island", "jay", "juniper", "kestrel",
  "koi", "lagoon", "lake", "lantern", "lark", "lemur", "lion", "lotus", "maple", "marigold",
  "meadow", "mesa", "moon", "mountain", "mouse", "nebula", "newt", "oak", "orchid", "osprey",
  "otter", "owl", "panda", "pebble", "penguin", "pine", "planet", "plume", "pond", "poppy",
  "prairie", "quartz", "rabbit", "raccoon", "raven", "reef", "river", "robin", "rocket", "salmon",
  "sequoia", "shell", "shore", "sparrow", "star", "stone", "storm", "stream", "summit", "swan",
] as const;

const RANDOM_RETRIES = 32;
type RandomIndex = (max: number) => number;

/** Allocates unique, readable session handles for one AgentManager lifetime. */
export class SessionIdAllocator {
  private readonly _allocated = new Set<string>();
  private _fallbackIndex = 0;

  constructor(private readonly _randomIndex: RandomIndex = randomInt) { }

  allocate(): string | undefined {
    for (let attempt = 0; attempt < RANDOM_RETRIES; attempt++) {
      const candidate = this._randomCandidate();
      if (this._allocated.has(candidate)) continue;
      this._allocated.add(candidate);
      return candidate;
    }

    // Continue through the finite base space after random retries so a collision-heavy source
    // cannot spin forever or repeatedly rescan previously allocated candidates.
    while (this._fallbackIndex < ADJECTIVES.length * NOUNS.length) {
      const adjective = ADJECTIVES[Math.floor(this._fallbackIndex / NOUNS.length)];
      const noun = NOUNS[this._fallbackIndex % NOUNS.length];
      this._fallbackIndex += 1;

      const candidate = `${adjective}-${noun}`;
      if (this._allocated.has(candidate)) continue;
      this._allocated.add(candidate);
      return candidate;
    }

    return undefined;
  }

  private _randomCandidate(): string {
    const adjective = ADJECTIVES[this._randomIndex(ADJECTIVES.length)];
    const noun = NOUNS[this._randomIndex(NOUNS.length)];
    return `${adjective}-${noun}`;
  }
}

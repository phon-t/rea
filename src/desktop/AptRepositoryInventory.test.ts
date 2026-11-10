import { existsSync } from "node:fs";
import { chmod, mkdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { createTestTempDirectory } from "../../tests/fixtures/temporaryDirectory.js";
import {
  APT_LOCATIONS,
  inspectAptRepositories,
  resolveAptLocations,
} from "./AptRepositoryInventory.js";
import { runHostQuery, type QueryRunner } from "./HostQuery.js";

describe.skipIf(process.platform !== "linux")(
  "inspectAptRepositories signed releases",
  () => {
    it
      .skipIf(process.getuid?.() === 0)(
      "keeps a denied signed release file unresolved instead of absent",
      async () => {
        const root = await createTestTempDirectory("apt-release-");
        const lists = join(root, "lists");
        const sourcesFile = join(root, "typora.list");
        await mkdir(lists, { recursive: true });
        await writeFile(
          join(lists, "downloads.typora.io_linux_._InRelease"),
          "-----BEGIN PGP SIGNED MESSAGE-----\n",
        );
        await writeFile(
          sourcesFile,
          "deb https://downloads.typora.io/linux ./\n",
        );
        const indexTargets = [
          "MetaKey: Packages",
          "Description: https://downloads.typora.io/linux ./ Packages",
          `Filename: ${join(lists, "downloads.typora.io_linux_._Packages.lz4")}`,
          "Codename: stable",
          "Origin: typora.io",
          "Suite: stable",
          "Base-URI: https://downloads.typora.io/linux/./",
          "Repo-URI: https://downloads.typora.io/linux/",
          `Sourcesentry: ${sourcesFile}:1`,
          "",
        ].join("\n");
        const runQuery: QueryRunner = async (command, argv) => {
          if (command === "apt-get" && argv[0] === "indextargets")
            return { stdout: indexTargets, exitCode: 0 };
          return "failed";
        };
        await chmod(lists, 0o000);
        try {
          const probe = await stat(
            join(lists, "downloads.typora.io_linux_._InRelease"),
          ).then(
            () => undefined,
            (cause: unknown) => cause,
          );
          expect(probe).toMatchObject({ code: "EACCES" });
          const facts = await inspectAptRepositories(
            {
              sources: ["https://downloads.typora.io/linux ./ Packages"],
              origins: ["typora.io"],
            },
            {
              runQuery,
              apt: {
                lists,
                trustedParts: join(root, "trusted.gpg.d"),
                trusted: join(root, "trusted.gpg"),
              },
            },
            undefined,
          );
          expect(facts.repositories).toHaveLength(1);
          expect(facts.repositories[0]?.signing_key_reason).toContain(
            `the signed release file for it in ${lists} could not be checked: EACCES: permission denied`,
          );
        } finally {
          await chmod(lists, 0o755);
        }
      },
    );
  },
);

describe.skipIf(
  process.platform !== "linux" || !existsSync("/usr/bin/apt-config"),
)("resolveAptLocations with apt-config", () => {
  it("reads the lists folder an APT_CONFIG file names, resolved under Dir::State", async () => {
    const root = await createTestTempDirectory("apt-config-");
    const config = join(root, "apt.conf");
    await writeFile(
      config,
      `Dir::State "${root}/state";\nDir::State::Lists "user lists";\n`,
    );
    const configured: QueryRunner = (command, argv, signal) =>
      runHostQuery("env", [`APT_CONFIG=${config}`, command, ...argv], signal);

    const locations = await resolveAptLocations(configured, undefined);

    expect(locations).toEqual({
      lists: `${root}/state/user lists/`,
      trustedParts: "/etc/apt/trusted.gpg.d/",
      trusted: "/etc/apt/trusted.gpg",
    });
    expect(
      await resolveAptLocations(
        (_command, argv, signal) =>
          runHostQuery("/missing/apt-config", argv, signal),
        undefined,
      ),
    ).toEqual(APT_LOCATIONS);
  });
});

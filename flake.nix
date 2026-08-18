{
  inputs = {
    ### Primary — jackpkgs owns the pin versions ###
    jackpkgs.url = "github:jmmaloney4/jackpkgs";

    ### Follow jackpkgs inputs wherever we also declare them ###
    nixpkgs.follows = "jackpkgs/nixpkgs"; # https://github.com/NixOS/nixpkgs/issues/483584
    flake-parts.follows = "jackpkgs/flake-parts";
    systems.follows = "jackpkgs/systems";
  };

  outputs = {
    self,
    nixpkgs,
    jackpkgs,
    flake-parts,
    systems,
  } @ inputs:
    flake-parts.lib.mkFlake {inherit inputs;} ({
      withSystem,
      inputs,
      ...
    }: {
      systems = import systems;
      imports = [
        jackpkgs.flakeModules.default
      ];

      jackpkgs.projectRoot = ./.;
      jackpkgs.nodejs = {
        enable = true;
        pnpmDepsHash = "sha256-LeFkdfR+2ilF+O2PnAHUY9vjAdn3JB41RIifDabMxao=";
        projectRoot = ./.;
      };
      jackpkgs.checks.typescript.tsc.enable = true;
      jackpkgs.checks.vitest.enable = true;
      jackpkgs.pulumi.enable = false;

      perSystem = {
        config,
        self',
        inputs',
        pkgs,
        system,
        lib,
        ...
      }: let
        renovateConfigFiles = [
          ".github/renovate.json5"
          "renovate/all.json"
          "renovate/default.json"
          "renovate/docker-images.json"
          "renovate/lock-maintenance.json"
          "renovate/major-updates.json"
          "renovate/minor-patch-automerge.json"
          "renovate/nix.json"
          "renovate/pulumi.json"
          "renovate/sector7-release-tarballs.json"
          "renovate/security.json"
          "renovate/yaml-manifests.json"
        ];

        renovateConfigPaths = map (path: "${self.outPath}/${path}") renovateConfigFiles;

        # Single source of truth for packages.pulumi-resource-sector7 AND
        # checks.provider-version-stamped, so the two can never desync — the
        # exact failure mode (a build path deriving the version one way, a
        # check asserting it a different way) that let v0.20.2 ship reporting
        # itself as "dev".
        providerVersion =
          (builtins.fromJSON (builtins.readFile ./packages/sector7/package.json)).version;
      in {
        jackpkgs.just.cut = {
          enable = true;
          files = [
            {
              type = "npm";
              path = "packages/sector7/package.json";
            }
            {
              type = "npm";
              path = "package.json";
            }
          ];
          commitMessage = "release: bump sector7 to {version}";
        };

        # jackpkgs' adr-conflict-check hook defaults to docs/internal/decisions;
        # this repo has always kept its ADRs in docs/internal/designs.
        jackpkgs.pre-commit.adr.directory = "docs/internal/designs";

        pre-commit.settings.hooks.mypy.enable = lib.mkForce false;
        pre-commit.settings.hooks.tsc.enable = lib.mkForce false;

        checks.renovate-config = pkgs.runCommand "renovate-config" {} ''
          cd ${self.outPath}
          for config in ${lib.concatMapStringsSep " " lib.escapeShellArg renovateConfigPaths}; do
            RENOVATE_CONFIG_FILE="$config" ${lib.getExe' pkgs.renovate "renovate-config-validator"} --strict
          done
          touch "$out"
        '';
        # The Pulumi resource provider (provider/), which replaces sector7's
        # dynamic providers. jackpkgs also packages this via nvfetcher for
        # downstream consumers; exposing it here means sector7's own CI builds
        # it on every PR (compute-flake-build-matrix selects packages.*), so Go
        # breakage surfaces in this repo rather than in jackpkgs.
        packages.pulumi-resource-sector7 = pkgs.buildGoModule {
          pname = "pulumi-resource-sector7";
          version = providerVersion;
          src = ./.;
          modRoot = "provider";
          # Maintained hash rather than a committed provider/vendor/: vendoring
          # this tree is 83 MB / 6518 files (client-go + the Pulumi SDK), which
          # would roughly triple the repo. A stale hash reds this repo's CI,
          # never a consumer's.
          vendorHash = "sha256-sGg1c8lDx94MqpEPIlVB1YHp/ZouJnphyz0+BWhnffI=";
          subPackages = ["cmd/pulumi-resource-sector7"];
          meta.mainProgram = "pulumi-resource-sector7";
          # provider/version/version.go defaults Version to "dev" precisely so
          # a build that forgets this line fails LOUDLY rather than silently
          # shipping a plugin that reports itself as "dev" to the Pulumi
          # engine. It does exactly that: "dev" is not valid semver, so
          # EVERY operation against EVERY resource this provider owns fails
          # at the provider-handshake step, before any real diffing even
          # starts — found in production via `pulumi preview` on litellm/prod
          # after v0.20.2 was already released and consumed downstream.
          #
          # checks.provider-version-stamped below asserts the built binary
          # actually reports providerVersion, not just that this line exists.
          ldflags = ["-X" "github.com/jmmaloney4/sector7/provider/version.Version=${providerVersion}"];
        };

        # Asserts the plugin binary's SELF-REPORTED version — not just that an
        # ldflags line exists in this file, which regressing to `dev` would
        # leave syntactically present but silently wrong (e.g. a typo'd
        # package path that Go accepts silently without ever linking against
        # the real `version.Version` symbol).
        #
        # `pulumi package get-schema <bin>` is the right tool for this, not a
        # `strings`/grep scan of the binary: Go's `-ldflags -X` stores the
        # string with no guaranteed null-byte boundary before it, so a raw
        # byte-run scanner can merge it with adjacent binary data (observed:
        # the actually-correct value showed up as "L0.20.2", an unrelated
        # preceding byte glued onto the front — this exact version number ALSO
        # coincidentally collides with an unrelated vendored dependency's own
        # pinned version string elsewhere in the binary, `go-openapi/jsonref-
        # erence@v0.20.2`, so even a substring match would have given a false
        # pass). `get-schema` sidesteps all of that: it drives the binary
        # through its real plugin-info path and hands back a JSON `version`
        # field with no ambiguity about string boundaries — confirmed this
        # reports literally `"version": "dev"` against the broken binary that
        # failed on litellm/prod, before this fix.
        checks.provider-version-stamped =
          pkgs.runCommand "provider-version-stamped" {
            nativeBuildInputs = [pkgs.pulumi-bin pkgs.jq];
            # Passed through the environment, not string-interpolated into the
            # script, so nothing about the value's content — however it is
            # ever derived in the future — is interpreted by the shell.
            want = providerVersion;
          } ''
            set -euo pipefail
            bin=${config.packages.pulumi-resource-sector7}/bin/pulumi-resource-sector7
            got=$(pulumi package get-schema "$bin" | jq -r .version)
            if [ "$got" != "$want" ]; then
              echo "plugin reports version '$got' via get-schema, expected '$want' —" \
                   "ldflags did not stamp the binary. This is exactly the bug that made" \
                   "every operation on every sector7 resource fail on litellm/prod." >&2
              exit 1
            fi
            touch $out
          '';

        # `go test ./...` across every resource package.
        #
        # A separate derivation because the package above sets
        # subPackages = ["cmd/..."], which also scopes buildGoModule's
        # checkPhase — so building the plugin proves it COMPILES and nothing
        # more. These tests are the entire safety argument for retyping
        # resources that own six live LiteLLM credentials and thirteen Attic
        # host tokens, so they have to run somewhere CI can see them.
        #
        # compute-flake-build-matrix selects checks.* as well as packages.*
        # (.github/actions/compute-flake-build-matrix/select.nix), so this runs
        # on every PR with no workflow change.
        checks.provider-go-test = pkgs.buildGoModule {
          pname = "provider-go-test";
          inherit (config.packages.pulumi-resource-sector7) version src modRoot vendorHash;
          # -race catches the class of bug that has already bitten this
          # provider twice during the port: a shared map in the port-forward
          # transport, and an append from the test server's goroutine.
          buildPhase = ''
            runHook preBuild
            # treefmt has no Go formatter wired up, so gofmt drift reaches main
            # unchallenged — it already has once.
            # vendor/ is materialised by buildGoModule and is not ours.
            unformatted=$(gofmt -l . | grep -v '^vendor/' || true)
            if [ -n "$unformatted" ]; then
              echo "gofmt would rewrite:" >&2
              echo "$unformatted" >&2
              exit 1
            fi
            go test -race ./...
            runHook postBuild
          '';
          installPhase = "touch $out";
          # Nothing is installed, so there is no binary to strip or fix up.
          dontStrip = true;
          dontFixup = true;
        };

        devShells.default = pkgs.mkShell {
          inputsFrom = [
            config.jackpkgs.outputs.devShell
          ];
          buildInputs = with pkgs; [
            pnpm
            envsubst
            renovate
            # Provider development (provider/). Not needed to build — jackpkgs
            # does that with buildGoModule — but required to run `go test`
            # locally against the ported CRUD.
            go
            gopls
          ];
        };
      };
    });
}

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
        pnpmDepsHash = "sha256-wC91tGjpyAS929g21f7tfXN8Enm61aYSERlLhZ+3qP8=";
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
          version =
            (builtins.fromJSON (builtins.readFile ./packages/sector7/package.json)).version;
          src = ./.;
          modRoot = "provider";
          # Maintained hash rather than a committed provider/vendor/: vendoring
          # this tree is 83 MB / 6518 files (client-go + the Pulumi SDK), which
          # would roughly triple the repo. A stale hash reds this repo's CI,
          # never a consumer's.
          vendorHash = "sha256-sGg1c8lDx94MqpEPIlVB1YHp/ZouJnphyz0+BWhnffI=";
          subPackages = ["cmd/pulumi-resource-sector7"];
          meta.mainProgram = "pulumi-resource-sector7";
        };

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

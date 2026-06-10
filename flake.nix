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
        pnpmDepsHash = "sha256-IwjvQIT1MmnuFy34miCC1F26IN2X2P2pTH42OxVlqV8=";
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
          "renovate/lock-maintenance.json"
          "renovate/major-updates.json"
          "renovate/minor-patch-automerge.json"
          "renovate/nix.json"
          "renovate/pulumi.json"
          "renovate/sector7-release-tarballs.json"
          "renovate/security.json"
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
        devShells.default = pkgs.mkShell {
          inputsFrom = [
            config.jackpkgs.outputs.devShell
          ];
          buildInputs = with pkgs; [
            pnpm
            envsubst
            renovate
          ];
        };
      };
    });
}

{
  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";

    obelisk = {
      url = "github:obeli-sk/obelisk/latest";
      inputs = {
        nixpkgs.follows = "nixpkgs";
        flake-utils.follows = "flake-utils";
      };
    };
  };

  outputs = { nixpkgs, flake-utils, obelisk, ... }:
    flake-utils.lib.eachDefaultSystem (system:
      let
        pkgs = nixpkgs.legacyPackages.${system};
        screenshotFonts = pkgs.makeFontsConf {
          fontDirectories = [ pkgs.dejavu_fonts ];
        };
      in {
        devShells.default = pkgs.mkShell {
          packages = [
            obelisk.packages.${system}.default
            pkgs.gh
          ];
        };
        devShells.screenshots = pkgs.mkShell {
          packages = [
            pkgs.nodejs
            pkgs.playwright-test
          ];
          shellHook = ''
            export NODE_PATH=${pkgs.playwright-test}/lib/node_modules''${NODE_PATH:+:$NODE_PATH}
            export PLAYWRIGHT_BROWSERS_PATH=${pkgs.playwright-driver.browsers}
            export FONTCONFIG_FILE=${screenshotFonts}
          '';
        };
      });
}

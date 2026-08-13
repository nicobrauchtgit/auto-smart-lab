{ pkgs ? import <nixpkgs> {} }:

pkgs.mkShell {
  packages = [
    pkgs.python313
  ];

  shellHook = ''
    export SMARTLAB_LOCAL_DEV=1
  '';
}

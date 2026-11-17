"""Keep checkout ignore rules out of the source distribution."""

from hatchling.builders.hooks.plugin.interface import BuildHookInterface


class CustomBuildHook(BuildHookInterface):
    def initialize(self, version, build_data):
        forced = build_data["force_include"]
        for path, destination in list(forced.items()):
            if destination in {".gitignore", ".hgignore"}:
                del forced[path]

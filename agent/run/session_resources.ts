import { DefaultResourceLoader } from "@earendil-works/pi-coding-agent";

type LoaderOptions = ConstructorParameters<typeof DefaultResourceLoader>[0];

/** Repository development guidance must never be auto-injected into agents. */
export function createPipelineResourceLoader(options: LoaderOptions) {
	return new DefaultResourceLoader({
		...options,
		noContextFiles: true,
		agentsFilesOverride: () => ({ agentsFiles: [] }),
	});
}

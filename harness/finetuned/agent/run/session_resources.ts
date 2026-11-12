import { DefaultResourceLoader, type Skill } from "@earendil-works/pi-coding-agent";

type LoaderOptions = ConstructorParameters<typeof DefaultResourceLoader>[0];

/** Runtime resources are explicit: no ambient extensions or development guidance. */
export function createPipelineResourceLoader(options: LoaderOptions, explicitSkills: readonly Skill[] = []) {
	return new DefaultResourceLoader({
		...options,
		// Pi still loads additionalExtensionPaths and inline factories with this flag.
		noExtensions: true,
		noSkills: true,
		skillsOverride: () => ({ skills: [...explicitSkills], diagnostics: [] }),
		noPromptTemplates: true,
		noContextFiles: true,
		agentsFilesOverride: () => ({ agentsFiles: [] }),
	});
}

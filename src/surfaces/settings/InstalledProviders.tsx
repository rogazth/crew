import { SettingsRow, SettingsSection } from "../../chrome/SettingsRow";
import { ProviderIcon } from "../../chrome/ProviderIcon";
import { useDefaultAgent } from "../../hooks/useDefaultAgent";
import { PROVIDERS } from "../../lib/providers";

/** Which CLIs this Mac has; Providers grows around it in S3 of docs/plans/2026-10-19-design-system-finish.md. */
export function InstalledProviders() {
  const { installed } = useDefaultAgent();
  return (
    <SettingsSection title="Installed">
      {PROVIDERS.map((provider) => {
        const found = installed.includes(provider);
        return (
          <SettingsRow key={provider.id} label={provider.label} description={provider.binary}>
            <ProviderIcon provider={provider.id} className="size-4" />
            <span className={found ? "text-text" : "text-text-muted"}>{found ? "Installed" : "Not found"}</span>
          </SettingsRow>
        );
      })}
    </SettingsSection>
  );
}

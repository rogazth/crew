// PROTOTYPE — throwaway. Variant C of the Connectors page: Crew's connectors
// (the vault a quiet line on their title, see VariantC.vaultspot) (the tiles) and
// what each provider has set up on its machine (the chips), each with its
// status and problems first. A click opens its page (VariantC.detail), where
// the problem and its fix are. Browse connectors swaps the page for the
// directory; adding one is a short guided sheet over it.
import { useEffect } from 'react';
import { Button } from '../../../chrome/kit';
import { SettingsPage } from '../ui';
import { Dock } from './VariantC.bits.prototype';
import { FromProviders } from './VariantC.clis.prototype';
import { ConnectDialog } from './VariantC.connect.prototype';
import { KEYFRAMES, ui, useUi, type Sheet } from './VariantC.lib.prototype';
import { DetailPage } from './VariantC.detail.prototype';
import { CustomDialog, DirectoryPage, SummaryDialog } from './VariantC.directory.prototype';
import { Installed } from './VariantC.sections.prototype';
import { VaultSheet } from './VariantC.vault.prototype';
import { useIntegrations } from './store.prototype';

export function VariantC() {
  const s = useIntegrations();
  const { sheet, hidden, view, detail } = useUi();
  // A new scenario starts the page over: no sheet, nothing hidden or landed.
  useEffect(() => ui.reset(), [s.scenario]);
  if (view === 'directory' || (view === 'detail' && detail))
    return (
      <>
        <style>{KEYFRAMES}</style>
        {view === 'detail' && detail ? <DetailPage key={JSON.stringify(detail)} detail={detail} /> : <DirectoryPage />}
        {sheet && <Sheets sheet={sheet} />}
        <Dock exclude={(flow) => hidden.includes(flow.target)} />
      </>
    );
  return (
    <SettingsPage
      title="Connectors"
      actions={
        <Button variant="primary" onClick={() => ui.go('directory')}>
          Browse connectors
        </Button>
      }
    >
      <style>{KEYFRAMES}</style>
      <Installed />
      <FromProviders />
      {sheet && <Sheets sheet={sheet} />}
      <Dock
        exclude={(flow) => hidden.includes(flow.target) || (sheet?.kind === 'vault' && flow.kind === 'vault-move')}
      />
    </SettingsPage>
  );
}

function Sheets({ sheet }: { sheet: Sheet }) {
  switch (sheet.kind) {
    case 'connect':
      return sheet.serviceId ? (
        <ConnectDialog key={`connect-${sheet.serviceId}`} serviceId={sheet.serviceId} moveFrom={sheet.moveFrom} />
      ) : null;
    case 'summary':
      return <SummaryDialog key={sheet.serviceId} serviceId={sheet.serviceId} back={sheet.back} />;
    case 'custom':
      return <CustomDialog />;
    case 'vault':
      return <VaultSheet />;
  }
}

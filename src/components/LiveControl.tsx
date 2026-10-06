// The presenter's panel: a QR code that turns anyone in the room into a customer, and switches
// for the network conditions (which banks are down or unstable, whether the biller is stuck).

import { useEffect, useState } from 'react';
import QRCode from 'qrcode';
import { Clapperboard, QrCode, RadioTower } from 'lucide-react';
import type { EngineState } from '../engine/agent';
import { BILLER } from '../engine/seed';
import type { BankHealth, BillerHealth } from '../engine/systems';
import { Panel } from './ui';

const BANK_OPTIONS: Array<[BankHealth, string]> = [['up', 'Up'], ['down', 'Down'], ['unstable', 'Unstable']];
const BILLER_OPTIONS: Array<[BillerHealth, string]> = [['up', 'Up'], ['stuck', 'Token stuck'], ['down', 'No answer']];

export function LiveControl({ state, busy, onBank, onBiller, onDemo }: {
  state: EngineState;
  busy: boolean;
  onBank: (bank: string, status: BankHealth) => void;
  onBiller: (status: BillerHealth) => void;
  onDemo: () => void;
}) {
  const appUrl = `${location.origin}/app/`;
  const [qr, setQr] = useState('');
  useEffect(() => {
    void QRCode.toString(appUrl, { type: 'svg', margin: 1, errorCorrectionLevel: 'M', color: { dark: '#0b1120', light: '#ffffff' } }).then(setQr);
  }, [appUrl]);

  return (
    <div className="live-control">
      <Panel title="Be the customer" icon={QrCode} aside="Scan with any phone">
        <div className="panel-body qr-body">
          {/* The SVG comes from the QR library, not from user input. */}
          <div className="qr" role="img" aria-label={`QR code for ${appUrl}`} dangerouslySetInnerHTML={{ __html: qr }} />
          <div>
            <p className="qr-lead">Open the bank app on your own phone, send money anywhere, and watch ACR handle whatever happens.</p>
            <a className="mono qr-link" href={appUrl} target="_blank" rel="noreferrer">{appUrl}</a>
          </div>
        </div>
      </Panel>

      <Panel title="Network conditions" icon={RadioTower} aside="Live: changes apply to the next transaction">
        <div className="panel-body">
          <table className="faults">
            <tbody>
              {Object.entries(state.bankStatus).map(([bank, status]) => (
                <tr key={bank}>
                  <th scope="row">{bank}</th>
                  <td>
                    <div role="radiogroup" aria-label={`${bank} status`} className={`segmented seg-${status}`}>
                      {BANK_OPTIONS.map(([value, label]) => (
                        <button key={value} type="button" role="radio" aria-checked={status === value} disabled={busy} onClick={() => onBank(bank, value)}>{label}</button>
                      ))}
                    </div>
                  </td>
                </tr>
              ))}
              <tr>
                <th scope="row">{BILLER} <span className="dim">(biller)</span></th>
                <td>
                  <div role="radiogroup" aria-label={`${BILLER} status`} className={`segmented seg-${state.billerStatus[BILLER]}`}>
                    {BILLER_OPTIONS.map(([value, label]) => (
                      <button key={value} type="button" role="radio" aria-checked={state.billerStatus[BILLER] === value} disabled={busy} onClick={() => onBiller(value)}>{label}</button>
                    ))}
                  </div>
                </td>
              </tr>
            </tbody>
          </table>
          <p className="fault-help">
            <strong>Down</strong>: the transfer fails for certain, so ACR can safely return the money.{' '}
            <strong>Unstable</strong>: it's stuck "in progress" and may still land, so ACR must not refund.
          </p>
          <button type="button" className="btn btn-sm" onClick={onDemo} disabled={busy}>
            <Clapperboard size={14} aria-hidden="true" />Run scripted demo (two seeded customers)
          </button>
        </div>
      </Panel>
    </div>
  );
}

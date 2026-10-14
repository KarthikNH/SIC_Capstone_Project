import React, { useState, useRef } from 'react';
import { useGridStore } from '../store';
import { X, UploadCloud, FileText, CheckCircle2, AlertTriangle, AlertCircle, ArrowRight, Loader2, Download } from 'lucide-react';

export const GridUploadModal: React.FC = () => {
  const { uploadModalOpen, setUploadModalOpen, uploadGrid, uploadStatus, setGridCase } = useGridStore();
  const [dragOver, setDragOver] = useState(false);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [customName, setCustomName] = useState('');
  const fileInputRef = useRef<HTMLInputElement>(null);

  if (!uploadModalOpen) return null;

  const handleFileDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      setSelectedFile(e.dataTransfer.files[0]);
    }
  };

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      setSelectedFile(e.target.files[0]);
    }
  };

  const handleUpload = async () => {
    if (!selectedFile) return;
    await uploadGrid(selectedFile, customName.trim() || undefined);
  };

  const handleUseGrid = (gridId: string) => {
    setGridCase(gridId);
    setUploadModalOpen(false);
    setSelectedFile(null);
    setCustomName('');
  };

  const result: any = uploadStatus.result;
  const isSuccess = Boolean(result && (result.valid || result.report?.valid));
  const warnings: string[] = result?.warnings || result?.report?.warnings || [];
  const errors: string[] = result?.errors || result?.report?.errors || [];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm p-4">
      <div className="bg-white border border-[#cfd3d8] shadow-2xl max-w-xl w-full p-6 relative max-h-[90vh] overflow-y-auto">
        {/* Header */}
        <div className="flex items-center justify-between pb-4 border-b border-[#e5e7eb] mb-5">
          <div>
            <p className="eyebrow">Grid Ingestion</p>
            <h3 className="text-lg font-serif font-bold text-ink">Upload Custom Power Grid</h3>
          </div>
          <button
            onClick={() => setUploadModalOpen(false)}
            className="text-[#666] hover:text-ink p-1 transition-colors"
            aria-label="Close upload modal"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Informational Guidance & Download Links */}
        <div className="bg-[#f9fafb] border border-[#e5e7eb] p-3.5 mb-5 text-xs text-[#555] space-y-2">
          <div className="flex items-center justify-between">
            <span className="font-semibold text-ink">Accepted file formats:</span>
            <div className="flex items-center gap-2">
              <a
                href={`${(import.meta.env.VITE_API_URL || '').replace(/\/+$/, '')}/templates/csv`}
                download="csv_schema_template.json"
                className="text-xs text-charcoal hover:underline flex items-center gap-1 font-mono"
              >
                <Download className="w-3 h-3" /> CSV Schema
              </a>
              <span>·</span>
              <a
                href={`${(import.meta.env.VITE_API_URL || '').replace(/\/+$/, '')}/templates/matpower-example`}
                download="case_example.m"
                className="text-xs text-charcoal hover:underline flex items-center gap-1 font-mono"
              >
                <Download className="w-3 h-3" /> MATPOWER .m
              </a>
            </div>
          </div>
          <p className="text-[11.5px] text-[#666]">
            Upload a MATPOWER <code className="bg-white px-1 border border-[#e0e0e0]">.m</code> file, Pandapower{' '}
            <code className="bg-white px-1 border border-[#e0e0e0]">.json</code>, or CSV zip containing{' '}
            <code className="bg-white px-1 border border-[#e0e0e0]">bus.csv</code> and{' '}
            <code className="bg-white px-1 border border-[#e0e0e0]">branch.csv</code>.
          </p>
          <div className="text-[11px] text-[#777] border-t border-[#e5e7eb] pt-1.5 flex justify-between">
            <span>Security constraints: max 5 MB · max 500 buses</span>
            <span className="font-mono text-[10.5px]">Pure text parser (no exec / unpickle)</span>
          </div>
        </div>

        {/* Drag and Drop Zone */}
        {!isSuccess && (
          <div className="space-y-4">
            <div
              onDragOver={(e) => {
                e.preventDefault();
                setDragOver(true);
              }}
              onDragLeave={() => setDragOver(false)}
              onDrop={handleFileDrop}
              onClick={() => fileInputRef.current?.click()}
              className={`border-2 border-dashed p-6 text-center cursor-pointer transition-colors ${
                dragOver
                  ? 'border-charcoal bg-[#f0f4f8]'
                  : selectedFile
                  ? 'border-charcoal/60 bg-[#fafafa]'
                  : 'border-[#cfd3d8] hover:border-charcoal bg-white'
              }`}
            >
              <input
                ref={fileInputRef}
                type="file"
                accept=".m,.json,.csv,.zip"
                onChange={handleFileSelect}
                className="hidden"
              />
              <UploadCloud className="w-8 h-8 text-[#888] mx-auto mb-2" />
              {selectedFile ? (
                <div>
                  <p className="text-xs font-semibold text-ink flex items-center justify-center gap-1.5">
                    <FileText className="w-3.5 h-3.5" /> {selectedFile.name}
                  </p>
                  <p className="text-[11px] text-[#888] mt-0.5 font-mono">
                    {(selectedFile.size / 1024).toFixed(1)} KB · Click to change file
                  </p>
                </div>
              ) : (
                <div>
                  <p className="text-xs font-medium text-ink">
                    Drop your grid network file here, or <span className="underline font-semibold">browse</span>
                  </p>
                  <p className="text-[11px] text-[#888] mt-1 font-mono">.m · .json · .csv · .zip</p>
                </div>
              )}
            </div>

            <div>
              <label htmlFor="grid-name-input" className="eyebrow block mb-1">
                Grid Display Name (Optional)
              </label>
              <input
                id="grid-name-input"
                type="text"
                placeholder={selectedFile ? selectedFile.name.replace(/\.[^/.]+$/, '') : 'e.g. IEEE 57-Bus System'}
                value={customName}
                onChange={(e) => setCustomName(e.target.value)}
                className="w-full text-xs p-2 border border-[#cfd3d8] focus:border-charcoal focus:outline-none"
              />
            </div>

            {uploadStatus.error && (
              <div className="p-3 bg-red/10 border border-red/30 text-red text-xs space-y-1">
                <div className="flex items-center gap-1.5 font-semibold">
                  <AlertCircle className="w-4 h-4 shrink-0" />
                  <span>Validation Error</span>
                </div>
                <p className="text-[11.5px] leading-relaxed">{uploadStatus.error}</p>
              </div>
            )}

            <div className="flex justify-end gap-3 pt-2">
              <button
                type="button"
                onClick={() => setUploadModalOpen(false)}
                className="px-4 py-2 text-xs border border-[#cfd3d8] hover:bg-[#f9fafb] text-[#555]"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleUpload}
                disabled={!selectedFile || uploadStatus.loading}
                className="btn-estate-dark py-2 px-5 text-xs flex items-center gap-2 disabled:opacity-50"
              >
                {uploadStatus.loading ? (
                  <>
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    <span>Parsing &amp; Validating...</span>
                  </>
                ) : (
                  <>
                    <span>Upload &amp; Ingest Grid</span>
                    <ArrowRight className="w-3.5 h-3.5" />
                  </>
                )}
              </button>
            </div>
          </div>
        )}

        {/* Validation Result & Summary Card */}
        {result && (
          <div className="space-y-4">
            {isSuccess ? (
              <div className="border border-[#bbf7d0] bg-[#f0fdf4] p-4 text-xs space-y-3">
                <div className="flex items-center gap-2 text-[#166534] font-semibold text-sm">
                  <CheckCircle2 className="w-5 h-5 text-[#16a34a]" />
                  <span>Grid Topology Validated Successfully</span>
                </div>

                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 pt-2 border-t border-[#dcfce7] text-[11.5px]">
                  <div>
                    <span className="text-[#666] block">Buses</span>
                    <span className="font-semibold text-ink font-mono">{result.num_buses}</span>
                  </div>
                  <div>
                    <span className="text-[#666] block">Branches</span>
                    <span className="font-semibold text-ink font-mono">{result.num_branches}</span>
                  </div>
                  <div>
                    <span className="text-[#666] block">Generators</span>
                    <span className="font-semibold text-ink font-mono">{result.num_generators}</span>
                  </div>
                  <div>
                    <span className="text-[#666] block">AC Power Flow</span>
                    <span className="font-semibold text-[#16a34a] font-mono">Converged</span>
                  </div>
                </div>

                {/* Warnings / Assumptions if any */}
                {warnings.length > 0 && (
                  <div className="mt-2 p-2 bg-[#fffbeb] border border-[#fef3c7] text-[#92400e] text-[11px] space-y-1">
                    <p className="font-semibold flex items-center gap-1">
                      <AlertTriangle className="w-3.5 h-3.5" /> Engineering Assumptions Made:
                    </p>
                    <ul className="list-disc pl-4 space-y-0.5">
                      {warnings.map((w, i) => (
                        <li key={i}>{w}</li>
                      ))}
                    </ul>
                  </div>
                )}

                {/* OOD Badge if outside standard training range */}
                {result.ood_status && result.ood_status.status !== 'in_range' && (
                  <div className="p-2.5 bg-amber/10 border border-amber/30 text-amber text-[11.5px] space-y-1">
                    <p className="font-semibold flex items-center gap-1.5">
                      <AlertTriangle className="w-3.5 h-3.5" /> Reliability Notice:
                    </p>
                    <p className="leading-snug">
                      Outside the range this model was trained on. Treat predictions on this grid as less reliable.
                    </p>
                  </div>
                )}

                <div className="pt-2 flex justify-end gap-3">
                  <button
                    onClick={() => {
                      setUploadModalOpen(false);
                    }}
                    className="px-3.5 py-1.5 text-xs border border-[#cfd3d8] bg-white hover:bg-[#f9fafb] text-[#555]"
                  >
                    Close
                  </button>
                  <button
                    onClick={() => handleUseGrid(result.grid_id)}
                    className="btn-estate-dark py-1.5 px-4 text-xs flex items-center gap-1.5"
                  >
                    <span>Load {result.name || result.grid_name || 'Grid'} on Map</span>
                    <ArrowRight className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>
            ) : (
              /* Errors in red with plain-language resolution guidance */
              <div className="border border-red/40 bg-red/5 p-4 text-xs space-y-3">
                <div className="flex items-center gap-2 text-red font-semibold text-sm">
                  <AlertCircle className="w-5 h-5 text-red" />
                  <span>Validation Failed</span>
                </div>
                <div className="space-y-1.5 text-[11.5px] text-[#444]">
                  {errors.map((err, idx) => (
                    <div key={idx} className="p-2 bg-white border border-red/20 text-red font-mono">
                      {err}
                    </div>
                  ))}
                </div>
                <p className="text-[11px] text-[#666]">
                  How to fix: Verify that a slack reference bus is declared, branch impedances (R &amp; X) are non-zero,
                  and the network forms a single interconnected component.
                </p>
                <div className="flex justify-end pt-2">
                  <button
                    onClick={() => setSelectedFile(null)}
                    className="btn-estate-dark py-1.5 px-4 text-xs"
                  >
                    Try Another File
                  </button>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
};

import React from "react";

export default function DeleteModal({ itemToDelete, setItemToDelete, executeDelete }) {
  if (!itemToDelete) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-[#122027]/40 backdrop-blur-sm animate-in fade-in duration-200">
      <div className="bg-white rounded-3xl max-w-sm w-full p-6 shadow-2xl space-y-4">
        <h3 className="text-xl font-bold text-[#122027]">
          {itemToDelete.type === "group" ? "Delete Entire Batch?" : "Delete Subtask?"}
        </h3>
        <p className="text-[#768994] text-sm leading-relaxed">
          {itemToDelete.type === "group"
            ? `This will permanently remove all ${itemToDelete.ids.length} subtasks grouped in this batch.`
            : "This recorded job session will be permanently removed."}
        </p>
        <div className="flex justify-end gap-3 pt-4">
          <button
            onClick={() => setItemToDelete(null)}
            className="px-5 py-2.5 text-sm font-semibold text-[#323b43] hover:bg-slate-100 rounded-xl transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={executeDelete}
            className="px-5 py-2.5 text-sm font-semibold text-white bg-rose-600 hover:bg-rose-700 rounded-xl shadow-sm shadow-rose-600/20 transition-[background-color,transform] active:scale-95"
          >
            Confirm
          </button>
        </div>
      </div>
    </div>
  );
}

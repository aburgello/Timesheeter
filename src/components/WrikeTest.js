import React, { useState } from "react";
import {
  Download,
  RefreshCw,
  Server,
  AlertCircle,
  FileJson,
  Search,
  ArrowUpDown,
  Filter,
} from "lucide-react";

export default function WrikeTest({
  wrikeData,
  syncNow,
  isSyncing,
  lastSynced,
  syncError,
}) {
  const loading = isSyncing;
  const error = syncError;

  const handleDownload = () => {
    if (!wrikeData) return;

    const dataStr = JSON.stringify(wrikeData, null, 2);
    const blob = new Blob([dataStr], { type: "application/json" });
    const url = URL.createObjectURL(blob);

    const link = document.createElement("a");
    link.href = url;
    link.download = `Wrike_Tasks_Export_${
      new Date().toISOString().split("T")[0]
    }.json`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  };

  const [searchTerm, setSearchTerm] = useState("");
  const [statusFilter, setStatusFilter] = useState("All");

  const [sortConfig, setSortConfig] = useState({
    key: "createdDate",
    direction: "desc",
  });

  const handleSort = (key) => {
    let direction = "asc";
    if (sortConfig.key === key && sortConfig.direction === "asc") {
      direction = "desc";
    }
    setSortConfig({ key, direction });
  };

  const processedData = React.useMemo(() => {
    if (!wrikeData) return null;
    let data = [...wrikeData];

    if (statusFilter !== "All") {
      data = data.filter((task) => task.status === statusFilter);
    }

    if (searchTerm) {
      const lowercasedTerm = searchTerm.toLowerCase();
      data = data.filter(
        (task) =>
          task.title.toLowerCase().includes(lowercasedTerm) ||
          (task.projectName &&
            task.projectName.toLowerCase().includes(lowercasedTerm)) ||
          (task.assignees &&
            task.assignees.toLowerCase().includes(lowercasedTerm)) ||
          (task.customStatusName &&
            task.customStatusName.toLowerCase().includes(lowercasedTerm))
      );
    }

    data.sort((a, b) => {
      let aVal = a[sortConfig.key] || "";
      let bVal = b[sortConfig.key] || "";

      if (sortConfig.key === "createdDate") {
        aVal = new Date(aVal).getTime();
        bVal = new Date(bVal).getTime();
      } else {
        aVal = String(aVal).toLowerCase();
        bVal = String(bVal).toLowerCase();
      }

      if (aVal < bVal) return sortConfig.direction === "asc" ? -1 : 1;
      if (aVal > bVal) return sortConfig.direction === "asc" ? 1 : -1;
      return 0;
    });

    return data;
  }, [wrikeData, searchTerm, statusFilter, sortConfig]);

  const TABLE_LIMIT = 500;
  const displayData = processedData?.slice(0, TABLE_LIMIT);

  return (
    <div className="min-h-screen bg-slate-100 text-[#122027] font-sans pb-12">
      <div className="max-w-[1800px] mx-auto px-4 sm:px-6 pt-8 space-y-6">
        <header className="bg-white shadow-sm border border-[#dce4ec] rounded-[2rem] p-6 sm:px-8 flex flex-col md:flex-row items-start md:items-center justify-between gap-5">
          <div className="flex items-center gap-4">
            <div className="bg-gradient-to-br from-indigo-500 to-purple-500 p-3.5 rounded-2xl text-white shadow-lg shadow-indigo-500/20">
              <Server className="w-8 h-8" />
            </div>
            <div>
              <h1 className="text-3xl font-black text-[#122027] tracking-tight">
                Wrike API Sandbox
              </h1>
              <p className="text-[#768994] text-sm font-medium mt-0.5">
                Fetch, view, and export raw task data
              </p>
            </div>
          </div>

          <div className="flex gap-3 w-full sm:w-auto">
            <button
              onClick={syncNow}
              disabled={loading}
              className="flex items-center justify-center gap-2 bg-[#122027] hover:bg-slate-800 text-white px-6 py-3 rounded-xl font-bold transition-all shadow-sm active:scale-95 disabled:opacity-50"
            >
              <RefreshCw
                className={`w-4 h-4 ${loading ? "animate-spin" : ""}`}
              />
              {loading ? "Fetching..." : "Fetch Wrike Data"}
            </button>

            <button
              onClick={handleDownload}
              disabled={!wrikeData}
              className="flex items-center justify-center gap-2 bg-emerald-50 text-emerald-600 border border-emerald-200 hover:bg-emerald-100 px-6 py-3 rounded-xl font-bold transition-all shadow-sm active:scale-95 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <Download className="w-4 h-4" />
              Download JSON
            </button>
          </div>
        </header>

        {error && (
          <div className="bg-rose-50 border border-rose-200 text-rose-700 p-4 rounded-2xl flex items-center gap-3">
            <AlertCircle className="w-5 h-5 text-rose-500" />
            <p className="font-bold text-sm">{error}</p>
          </div>
        )}

        {processedData ? (
          <div className="bg-white rounded-3xl border border-[#dce4ec] shadow-xl shadow-slate-200/40 overflow-hidden">
            <div className="p-5 border-b border-[#dce4ec] bg-slate-50/50 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
              <h2 className="text-base font-black text-[#122027] flex items-center gap-2">
                <FileJson className="w-4 h-4 text-indigo-500" /> Task Array (
                {processedData.length} items{processedData.length > TABLE_LIMIT ? ` — showing first ${TABLE_LIMIT}` : ""})
              </h2>

              <div className="flex flex-col sm:flex-row gap-3">
                <div className="relative flex items-center">
                  <Search className="w-4 h-4 text-[#768994] absolute left-3" />
                  <input
                    type="text"
                    placeholder="Search tasks..."
                    value={searchTerm}
                    onChange={(e) => setSearchTerm(e.target.value)}
                    className="pl-9 pr-3 py-2 bg-white border border-[#dce4ec] rounded-xl text-sm outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/20 transition-all w-full sm:w-64"
                  />
                </div>

                <div className="relative flex items-center">
                  <Filter className="w-4 h-4 text-[#768994] absolute left-3" />
                  <select
                    value={statusFilter}
                    onChange={(e) => setStatusFilter(e.target.value)}
                    className="pl-9 pr-8 py-2 bg-white border border-[#dce4ec] rounded-xl text-sm outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/20 transition-all cursor-pointer appearance-none"
                  >
                    <option value="All">All Base Statuses</option>
                    <option value="Active">Active</option>
                    <option value="Completed">Completed</option>
                    <option value="Deferred">Deferred</option>
                    <option value="Cancelled">Cancelled</option>
                  </select>
                </div>
              </div>
            </div>

            <div className="overflow-x-auto max-h-[600px] overflow-y-auto scrollbar-thin">
              <table className="w-full text-left text-sm text-[#122027]">
                <thead className="bg-slate-50 text-xs uppercase text-[#768994] font-black sticky top-0 border-b border-[#dce4ec] shadow-sm z-10">
                  <tr>
                    <th className="px-6 py-4">
                      <button
                        onClick={() => handleSort("customStatusName")}
                        className="flex items-center gap-1.5 hover:text-[#122027] transition-colors"
                      >
                        Workflow / Status <ArrowUpDown className="w-3 h-3" />
                      </button>
                    </th>
                    <th className="px-6 py-4">
                      <button
                        onClick={() => handleSort("projectName")}
                        className="flex items-center gap-1.5 hover:text-[#122027] transition-colors"
                      >
                        Film / Project <ArrowUpDown className="w-3 h-3" />
                      </button>
                    </th>
                    <th className="px-6 py-4">Assignees</th>
                    <th className="px-6 py-4">
                      <button
                        onClick={() => handleSort("title")}
                        className="flex items-center gap-1.5 hover:text-[#122027] transition-colors"
                      >
                        Task Title <ArrowUpDown className="w-3 h-3" />
                      </button>
                    </th>
                    <th className="px-6 py-4">
                      <button
                        onClick={() => handleSort("createdDate")}
                        className="flex items-center gap-1.5 hover:text-[#122027] transition-colors"
                      >
                        Created <ArrowUpDown className="w-3 h-3" />
                      </button>
                    </th>
                    <th className="px-6 py-4">
                      <button
                        onClick={() => handleSort("importance")}
                        className="flex items-center gap-1.5 hover:text-[#122027] transition-colors"
                      >
                        Importance <ArrowUpDown className="w-3 h-3" />
                      </button>
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[#dce4ec]">
                  {displayData.length > 0 ? (
                    displayData.map((task) => (
                      <tr
                        key={task.id}
                        className="hover:bg-slate-50/50 transition-colors"
                      >
                        <td className="px-6 py-4 whitespace-nowrap">
                          <span
                            className={`px-2.5 py-1 text-[10px] font-black uppercase tracking-wider rounded-md border ${
                              task.status === "Completed"
                                ? "bg-emerald-50 text-emerald-600 border-emerald-100"
                                : task.status === "Active"
                                ? "bg-blue-50 text-blue-600 border-blue-100"
                                : "bg-slate-100 text-slate-600 border-slate-200"
                            }`}
                          >
                            {task.customStatusName}
                          </span>
                        </td>
                        <td
                          className="px-6 py-4 font-bold text-indigo-600 truncate max-w-[200px]"
                          title={task.projectName}
                        >
                          {task.projectName}
                        </td>

                        <td className="px-6 py-4 text-[#768994] font-medium truncate max-w-[150px]">
                          {task.assignees}
                        </td>

                        <td
                          className="px-6 py-4 font-bold max-w-md truncate"
                          title={task.title}
                        >
                          <a
                            href={task.permalink}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="hover:text-indigo-500 hover:underline decoration-2 underline-offset-2 transition-colors cursor-pointer"
                          >
                            {task.title}
                          </a>
                        </td>
                        <td className="px-6 py-4 whitespace-nowrap text-[#768994] font-medium">
                          {new Date(task.createdDate).toLocaleDateString()}
                        </td>
                        <td className="px-6 py-4 capitalize text-[#768994]">
                          {task.importance}
                        </td>
                      </tr>
                    ))
                  ) : (
                    <tr>
                      <td
                        colSpan="6"
                        className="px-6 py-12 text-center text-[#768994] font-medium"
                      >
                        No tasks match your filters.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        ) : (
          <div className="bg-white rounded-3xl border border-dashed border-[#dce4ec] h-64 flex flex-col items-center justify-center text-[#768994] gap-3">
            <Server className="w-10 h-10 opacity-20" />
            <p className="font-bold text-sm">
              Hit fetch to grab your live Wrike data
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

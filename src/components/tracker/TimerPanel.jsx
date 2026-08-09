import React from "react";
import {
  Clock, Play, Pause, CheckCircle, CheckSquare, ChevronDown,
  Timer as TimerIcon, Keyboard, Sparkles, Trophy, RefreshCw,
} from "lucide-react";
import { formatTimerDisplay } from "../../utils/timeHelpers";

export default function TimerPanel({
  // Timer state
  isRunning, elapsedTime, entryMode, setEntryMode,
  manualHours, setManualHours, manualMinutes, setManualMinutes,
  showReward,
  handleToggleTimer, handleLogTask,
  // Sidebar shortcuts
  tasks, onNavigateToHub,
  // Wrike user / stats
  wrikeUser, userStats, handleFetchLifetimeStats,
}) {
  return (
    <aside className="w-full lg:w-[320px] xl:w-[360px] shrink-0 sticky top-6 space-y-4">
      {/* Timer Card */}
      <div className="bg-white border border-[#dce4ec] shadow-xl shadow-slate-200/40 rounded-3xl p-5 relative overflow-hidden">
        {isRunning && (
          <div className="absolute inset-0 bg-[#12a0e1]/5 animate-pulse pointer-events-none" />
        )}

        <div className="flex items-center justify-between mb-4">
          <h3 className="text-sm font-black text-[#122027] uppercase tracking-widest flex items-center gap-1.5">
            <Clock className="w-4 h-4 text-[#12a0e1]" /> Tracker
          </h3>
          {isRunning && (
            <span className="flex w-2.5 h-2.5 rounded-full bg-rose-500 animate-pulse shadow-sm shadow-rose-500/50" />
          )}
        </div>

        {/* Mode toggle */}
        <div className="flex bg-slate-50 border border-[#dce4ec] rounded-lg p-1 mb-5 relative z-10 w-full">
          <button
            onClick={() => setEntryMode("timer")}
            className={`flex-1 flex items-center justify-center gap-1.5 py-1.5 text-xs font-bold rounded-md transition-[transform,background-color,border-color] ${
              entryMode === "timer" ? "bg-[#12a0e1] text-white shadow-sm" : "text-[#768994] hover:text-[#122027]"
            }`}
          >
            <TimerIcon className="w-3.5 h-3.5" /> Timer
          </button>
          <button
            onClick={() => setEntryMode("manual")}
            className={`flex-1 flex items-center justify-center gap-1.5 py-1.5 text-xs font-bold rounded-md transition-[transform,background-color,border-color] ${
              entryMode === "manual" ? "bg-[#12a0e1] text-white shadow-sm" : "text-[#768994] hover:text-[#122027]"
            }`}
          >
            <Keyboard className="w-3.5 h-3.5" /> Manual
          </button>
        </div>

        {entryMode === "timer" ? (
          <div className="text-center space-y-4">
            <div className={`text-4xl font-black font-mono tracking-tighter transition-colors duration-300 relative z-10 ${isRunning ? "text-[#12a0e1]" : "text-[#122027]"}`}>
              {formatTimerDisplay(elapsedTime)}
            </div>
            <div className="flex items-center justify-center gap-2">
              <span className="text-[10px] font-black text-[#768994] uppercase tracking-widest">Raw Accumulation:</span>
              <span className="text-xs font-bold text-[#12a0e1] bg-[#12a0e1]/10 px-2 py-0.5 rounded-md">
                {Math.floor(elapsedTime / 60)}m
              </span>
            </div>
            <button
              onClick={handleToggleTimer}
              className={`w-full flex items-center justify-center gap-2 py-3 rounded-xl font-black text-white transition-[background-color,box-shadow,transform] transform active:scale-95 shadow-md text-sm ${
                isRunning ? "bg-amber-500 hover:bg-amber-600 shadow-amber-500/20" : "bg-[#122027] hover:bg-[#25373c]"
              }`}
            >
              {isRunning ? <><Pause className="w-4 h-4" /> Pause</> :
               elapsedTime === 0 ? <><Play className="w-4 h-4" /> Start</> :
               <><Play className="w-4 h-4" /> Resume</>}
            </button>
          </div>
        ) : (
          <div className="space-y-4">
            <div className="flex items-center justify-center gap-3">
              {[
                { value: manualHours, set: setManualHours, label: "Hrs", max: undefined },
                { value: manualMinutes, set: setManualMinutes, label: "Mins", max: 59 },
              ].map(({ value, set, label, max }, i) => (
                <React.Fragment key={label}>
                  {i > 0 && <span className="text-2xl font-black text-[#dce4ec] pb-4">:</span>}
                  <div className="flex flex-col items-center">
                    <input
                      type="number" min="0" max={max}
                      value={value} onChange={(e) => set(e.target.value)} placeholder="0"
                      className="w-16 bg-white text-center text-2xl font-black text-[#122027] border border-[#dce4ec] focus:border-[#12a0e1] focus:ring-2 focus:ring-[#12a0e1]/20 rounded-xl py-2 outline-none shadow-sm transition-[border-color,box-shadow]"
                    />
                    <span className="text-[10px] text-[#768994] font-black uppercase mt-1 tracking-widest">{label}</span>
                  </div>
                </React.Fragment>
              ))}
            </div>
            <div className="flex items-center justify-center gap-2">
              <span className="text-[10px] font-black text-[#768994] uppercase tracking-widest">Raw Accumulation:</span>
              <span className="text-xs font-bold text-[#12a0e1] bg-[#12a0e1]/10 px-2 py-0.5 rounded-md">
                {parseInt(manualHours || 0) * 60 + parseInt(manualMinutes || 0)}m
              </span>
            </div>
          </div>
        )}

        <hr className="border-[#dce4ec] my-5" />

        {/* Sparkle animation styles */}
        <style>{`
          @keyframes floatUpLeft { 0% { transform: translate(0,0) scale(0.5); opacity:0; } 20% { opacity:1; } 100% { transform: translate(-50px,-60px) scale(1.2) rotate(-45deg); opacity:0; } }
          @keyframes floatUp { 0% { transform: translate(0,0) scale(0.5); opacity:0; } 20% { opacity:1; } 100% { transform: translate(0,-70px) scale(1.5); opacity:0; } }
          @keyframes floatUpRight { 0% { transform: translate(0,0) scale(0.5); opacity:0; } 20% { opacity:1; } 100% { transform: translate(50px,-60px) scale(1.2) rotate(45deg); opacity:0; } }
          .animate-sparkle-left { animation: floatUpLeft 1s cubic-bezier(0.25,1,0.5,1) forwards; }
          .animate-sparkle-center { animation: floatUp 1s cubic-bezier(0.25,1,0.5,1) forwards; }
          .animate-sparkle-right { animation: floatUpRight 1s cubic-bezier(0.25,1,0.5,1) forwards; }
        `}</style>

        <div className="relative w-full">
          {showReward && (
            <div className="absolute inset-0 pointer-events-none flex items-center justify-center z-50">
              <Sparkles className="absolute text-amber-400 w-6 h-6 animate-sparkle-left" />
              <Sparkles className="absolute text-[#1cc1a5] w-8 h-8 animate-sparkle-center" style={{ animationDelay: "50ms" }} />
              <Sparkles className="absolute text-[#12a0e1] w-6 h-6 animate-sparkle-right" style={{ animationDelay: "100ms" }} />
            </div>
          )}
          <button
            onClick={handleLogTask}
            disabled={entryMode === "timer" && (isRunning || elapsedTime === 0)}
            className={`w-full flex items-center justify-center gap-2 py-3 px-4 rounded-xl font-bold text-white disabled:bg-slate-200 disabled:text-slate-400 disabled:cursor-not-allowed transition-[transform,background-color,border-color] text-sm ${
              showReward ? "bg-[#15a38b] scale-[1.03] shadow-lg shadow-[#1cc1a5]/40" : "bg-[#1cc1a5] hover:bg-[#15a38b] shadow-md shadow-[#1cc1a5]/20 active:scale-95"
            }`}
          >
            <CheckCircle className="w-4 h-4" /> Log Subtask
          </button>
        </div>
      </div>

      {/* Recent Jobs shortcut */}
      <button
        onClick={() => onNavigateToHub?.("jobs")}
        className="w-full bg-white rounded-3xl border border-[#dce4ec] p-5 flex items-center justify-between gap-4 shadow-sm hover:shadow-md hover:border-[#12a0e1]/40 transition-[box-shadow,border-color] group"
      >
        <div className="flex items-center gap-4">
          <div className="bg-[#12a0e1]/10 p-3.5 rounded-2xl text-[#12a0e1] border border-[#12a0e1]/20 group-hover:scale-110 group-hover:bg-[#12a0e1] group-hover:text-white transition-[background-color,color,transform]">
            <Clock className="w-5 h-5" />
          </div>
          <div className="text-left">
            <p className="text-[10px] text-[#768994] font-black tracking-widest uppercase mb-1">Shortcut</p>
            <p className="text-lg font-black text-[#122027] tracking-tight group-hover:text-[#12a0e1] transition-colors">Recent Jobs</p>
          </div>
        </div>
        <ChevronDown className="w-5 h-5 text-[#768994] -rotate-90 group-hover:text-[#12a0e1] transition-colors" />
      </button>

      {/* Completed Jobs shortcut */}
      <button
        onClick={() => onNavigateToHub?.("completed")}
        className="w-full bg-white rounded-3xl border border-[#dce4ec] p-5 flex items-center justify-between gap-4 shadow-sm hover:shadow-md hover:border-[#1cc1a5]/40 transition-[box-shadow,border-color] group"
      >
        <div className="flex items-center gap-4">
          <div className="bg-[#1cc1a5]/10 p-3.5 rounded-2xl text-[#1cc1a5] border border-[#1cc1a5]/20 group-hover:scale-110 group-hover:bg-[#1cc1a5] group-hover:text-white transition-[background-color,color,transform]">
            <CheckSquare className="w-5 h-5" />
          </div>
          <div className="text-left">
            <p className="text-[10px] text-[#768994] font-black tracking-widest uppercase mb-1">Shortcut</p>
            <p className="text-lg font-black text-[#122027] tracking-tight group-hover:text-[#1cc1a5] transition-colors">Completed Jobs</p>
          </div>
        </div>
        <ChevronDown className="w-5 h-5 text-[#768994] -rotate-90 group-hover:text-[#1cc1a5] transition-colors" />
      </button>

      {/* Subtasks logged */}
      <div className="bg-white rounded-3xl border border-[#dce4ec] p-5 flex items-center gap-4 shadow-sm">
        <div className="bg-[#1cc1a5]/10 p-3.5 rounded-2xl text-[#1cc1a5] border border-[#1cc1a5]/20">
          <CheckCircle className="w-5 h-5" />
        </div>
        <div>
          <p className="text-[10px] text-[#768994] font-black tracking-widest uppercase mb-1">Subtasks Logged</p>
          <p className="text-2xl font-black text-[#122027] tracking-tight">
            {tasks.length} <span className="text-sm text-[#768994] font-bold">subs</span>
          </p>
        </div>
      </div>

      {/* Wrike lifetime stats */}
      {wrikeUser && (
        <div className="bg-gradient-to-br from-[#0d8bc4] to-[#0f766e] rounded-3xl border border-[#0f766e]/20 p-5 shadow-lg shadow-[#0f766e]/20 text-white relative overflow-hidden group">
          <div className="absolute top-0 right-0 w-32 h-32 bg-white/10 rounded-full blur-2xl -mr-10 -mt-10 group-hover:scale-150 transition-transform duration-700 pointer-events-none" />
          <div className="flex items-center justify-between mb-7 relative z-10">
            <div className="flex items-center gap-3">
              <div className="bg-white/20 p-2.5 rounded-xl backdrop-blur-sm border border-white/20">
                <Trophy className="w-5 h-5 text-white drop-shadow-sm" />
              </div>
              <p className="text-xs text-white font-black tracking-widest uppercase">Your Total Deliveries!</p>
            </div>
            {!userStats.fetched && (
              <button
                onClick={handleFetchLifetimeStats}
                disabled={userStats.loading}
                className="text-[10px] bg-white/20 hover:bg-white/30 text-white px-2.5 py-1.5 rounded-lg font-bold transition-colors border border-white/10 flex items-center gap-1.5 disabled:opacity-50"
              >
                <RefreshCw className={`w-3 h-3 ${userStats.loading ? "animate-spin" : ""}`} />
                {userStats.loading ? "Syncing..." : "Sync Lifetime"}
              </button>
            )}
          </div>
          <div className="relative z-10 grid grid-cols-3 gap-2">
            {[
              { label: "30 Days", value: userStats.month },
              { label: String(new Date().getFullYear()), value: userStats.year },
              { label: "All Time", value: userStats.allTime, highlight: true },
            ].map(({ label, value, highlight }) => (
              <div key={label} className="bg-white/10 rounded-xl p-3 border border-white/10 flex flex-col justify-center">
                <span className="text-[10px] text-white font-black uppercase tracking-widest mb-0.5">{label}</span>
                <span className={`text-lg font-black tracking-tight ${highlight ? "text-[#1cc1a5]" : ""}`}>
                  {userStats.fetched ? value : "-"}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Lottie mascot */}
      <div className="flex justify-center items-center pt-6 pb-2 opacity-70 hover:opacity-100 transition-opacity duration-300 pointer-events-none">
        <dotlottie-wc
          src="https://lottie.host/5bdfb93b-4c26-417b-a847-26f90081f142/pWyIxPNI7H.lottie"
          autoplay={true} loop={true}
          style={{ width: "300px", height: "300px" }}
        />
      </div>
    </aside>
  );
}

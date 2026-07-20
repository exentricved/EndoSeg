import React, { useState } from "react";

interface Props {
  onDone(): void;
}

export default function SetupView({ onDone }: Props): React.ReactElement {
  const [name, setName] = useState("");
  const [error, setError] = useState("");

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) { setError("Please enter your name."); return; }
    await window.reviewerApi.setReviewerName(trimmed);
    onDone();
  }

  return (
    <div className="setup-view">
      <div className="setup-card">
        <h1 className="setup-title">EndoSeg Review</h1>
        <p className="setup-subtitle">
          Your name will be recorded in every review package you save.
        </p>
        <form onSubmit={handleSubmit} className="setup-form">
          <label className="setup-label" htmlFor="reviewer-name">Your name</label>
          <input
            id="reviewer-name"
            className="setup-input"
            type="text"
            placeholder="e.g. Dr. Jane Smith"
            value={name}
            onChange={(e) => { setName(e.target.value); setError(""); }}
            autoFocus
          />
          {error && <p className="setup-error">{error}</p>}
          <button className="btn-primary setup-btn" type="submit">
            Continue
          </button>
        </form>
      </div>
    </div>
  );
}

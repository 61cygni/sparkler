import { useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";

function UserSection({ title, users, emptyLabel, busyUserId, onSetStatus }) {
  return (
    <section style={{ marginTop: "2rem" }}>
      <h2>{title}</h2>
      {users === undefined ? (
        <p className="muted">Loading…</p>
      ) : users.length === 0 ? (
        <p className="muted">{emptyLabel}</p>
      ) : (
        <div className="card-grid">
          {users.map((user) => (
            <div className="card" key={user._id}>
              <h3 style={{ marginTop: 0 }}>{user.name || user.email || user.subject}</h3>
              <p className="muted" style={{ fontSize: "0.9rem", marginBottom: "0.75rem" }}>
                {user.email || "No email"}
                <br />
                {user.subject}
              </p>
              <p className="muted" style={{ fontSize: "0.85rem" }}>
                role: {user.role} · status: {user.approvalStatus}
              </p>
              <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
                {user.approvalStatus !== "approved" ? (
                  <button
                    type="button"
                    disabled={busyUserId === user._id}
                    onClick={() => void onSetStatus(user._id, "approved")}
                  >
                    {busyUserId === user._id ? "Saving…" : "Approve"}
                  </button>
                ) : null}
                {user.approvalStatus !== "rejected" ? (
                  <button
                    type="button"
                    disabled={busyUserId === user._id}
                    onClick={() => void onSetStatus(user._id, "rejected")}
                  >
                    {busyUserId === user._id ? "Saving…" : "Reject"}
                  </button>
                ) : null}
                {user.approvalStatus !== "pending" ? (
                  <button
                    type="button"
                    disabled={busyUserId === user._id}
                    onClick={() => void onSetStatus(user._id, "pending")}
                  >
                    {busyUserId === user._id ? "Saving…" : "Set pending"}
                  </button>
                ) : null}
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

export default function AdminAccess() {
  const accountStatus = useQuery(api.users.getMyAccountStatus);
  const canManageUsers = accountStatus?.isAdmin === true;
  const pendingUsers = useQuery(
    api.users.listUsersByApprovalStatus,
    canManageUsers ? { approvalStatus: "pending", limit: 100 } : "skip",
  );
  const approvedUsers = useQuery(
    api.users.listUsersByApprovalStatus,
    canManageUsers ? { approvalStatus: "approved", limit: 100 } : "skip",
  );
  const rejectedUsers = useQuery(
    api.users.listUsersByApprovalStatus,
    canManageUsers ? { approvalStatus: "rejected", limit: 100 } : "skip",
  );
  const setApprovalStatus = useMutation(api.users.setUserApprovalStatus);
  const [busyUserId, setBusyUserId] = useState(null);
  const [error, setError] = useState("");

  async function onSetStatus(userId, approvalStatus) {
    setBusyUserId(userId);
    setError("");
    try {
      await setApprovalStatus({ userId, approvalStatus });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyUserId(null);
    }
  }

  if (accountStatus === undefined) {
    return (
      <div className="page">
        <h1 style={{ marginTop: 0 }}>Access approvals</h1>
        <p className="muted">Loading…</p>
      </div>
    );
  }

  if (!canManageUsers) {
    return (
      <div className="page">
        <h1 style={{ marginTop: 0 }}>Access approvals</h1>
        <p className="muted">Admin access is required.</p>
      </div>
    );
  }

  return (
    <div className="page">
      <h1 style={{ marginTop: 0 }}>Access approvals</h1>
      <p className="muted">
        New Clerk sign-ins are created as pending users unless they match an auto-approve or
        admin allowlist in the Convex environment.
      </p>
      {error ? (
        <p style={{ color: "#f5a8a8", marginTop: "1rem" }}>{error}</p>
      ) : null}
      <UserSection
        title="Pending"
        users={pendingUsers}
        emptyLabel="No pending users."
        busyUserId={busyUserId}
        onSetStatus={onSetStatus}
      />
      <UserSection
        title="Approved"
        users={approvedUsers}
        emptyLabel="No approved users yet."
        busyUserId={busyUserId}
        onSetStatus={onSetStatus}
      />
      <UserSection
        title="Rejected"
        users={rejectedUsers}
        emptyLabel="No rejected users."
        busyUserId={busyUserId}
        onSetStatus={onSetStatus}
      />
    </div>
  );
}

"""
GINE (Graph Isomorphism Network with Edge features) architecture for power grid cascading failure prediction.

Features:
- Input linear projections for heterogeneous node and edge features.
- Configurable number of GINEConv layers with internal MLPs, batch normalization, residual connections, and dropout.
- Configurable graph readout: sum pooling, mean pooling, or attentional pooling.
- MLP classification head producing unnormalized logits (compatible with BCEWithLogitsLoss / FocalLoss)
  and calibrated cascade probabilities.
- Ablation switches: toggle edge features, readout mechanisms, and layer depths.
"""

from typing import Optional, Union
import torch
import torch.nn as nn
from torch_geometric.nn import GINEConv, GINConv, global_add_pool, global_mean_pool
from torch_geometric.nn.aggr import AttentionalAggregation


class GINEClassifier(nn.Module):
    """
    GINE-based Graph Classifier with edge-conditioned message passing.
    """

    def __init__(
        self,
        node_in_dim: int,
        edge_in_dim: int,
        hidden_dim: int = 64,
        num_layers: int = 3,
        dropout: float = 0.15,
        readout: str = "sum",
        use_edge_features: bool = True
    ):
        super().__init__()
        self.node_in_dim = node_in_dim
        self.edge_in_dim = edge_in_dim
        self.hidden_dim = hidden_dim
        self.num_layers = num_layers
        self.dropout_rate = dropout
        self.readout_type = readout.lower()
        self.use_edge_features = use_edge_features

        # 1. Input Projections
        self.node_proj = nn.Sequential(
            nn.Linear(node_in_dim, hidden_dim),
            nn.BatchNorm1d(hidden_dim),
            nn.ReLU()
        )

        if self.use_edge_features and edge_in_dim > 0:
            self.edge_proj = nn.Sequential(
                nn.Linear(edge_in_dim, hidden_dim),
                nn.BatchNorm1d(hidden_dim),
                nn.ReLU()
            )
        else:
            self.edge_proj = None

        # 2. GINEConv Message Passing Layers
        self.convs = nn.ModuleList()
        self.batch_norms = nn.ModuleList()

        for _ in range(num_layers):
            node_mlp = nn.Sequential(
                nn.Linear(hidden_dim, hidden_dim * 2),
                nn.BatchNorm1d(hidden_dim * 2),
                nn.ReLU(),
                nn.Dropout(dropout),
                nn.Linear(hidden_dim * 2, hidden_dim)
            )

            if self.use_edge_features:
                conv = GINEConv(node_mlp, edge_dim=hidden_dim)
            else:
                conv = GINConv(node_mlp)

            self.convs.append(conv)
            self.batch_norms.append(nn.BatchNorm1d(hidden_dim))

        self.activation = nn.ReLU()
        self.dropout = nn.Dropout(dropout)

        # 3. Readout (Graph-Level Pooling)
        if self.readout_type == "sum":
            self.readout = None  # global_add_pool
        elif self.readout_type == "mean":
            self.readout = None  # global_mean_pool
        elif self.readout_type == "attention":
            gate_nn = nn.Sequential(
                nn.Linear(hidden_dim, hidden_dim // 2),
                nn.ReLU(),
                nn.Linear(hidden_dim // 2, 1)
            )
            self.readout = AttentionalAggregation(gate_nn)
        else:
            raise ValueError(f"Unsupported readout: {readout}. Choose 'sum', 'mean', or 'attention'.")

        # 4. Classification Head
        self.head = nn.Sequential(
            nn.Linear(hidden_dim, hidden_dim // 2),
            nn.BatchNorm1d(hidden_dim // 2),
            nn.ReLU(),
            nn.Dropout(dropout),
            nn.Linear(hidden_dim // 2, 1)
        )

    def forward(
        self,
        x: torch.Tensor,
        edge_index: torch.Tensor,
        edge_attr: Optional[torch.Tensor] = None,
        batch: Optional[torch.Tensor] = None
    ) -> torch.Tensor:
        """
        Forward pass.

        Args:
            x (torch.Tensor): Node feature matrix [num_nodes, node_in_dim].
            edge_index (torch.Tensor): Graph connectivity [2, num_edges].
            edge_attr (Optional[torch.Tensor]): Edge feature matrix [num_edges, edge_in_dim].
            batch (Optional[torch.Tensor]): Batch assignment vector [num_nodes].

        Returns:
            torch.Tensor: Unnormalized scalar logits [batch_size].
        """
        if batch is None:
            batch = torch.zeros(x.size(0), dtype=torch.long, device=x.device)

        # Node projection
        h = self.node_proj(x)

        # Edge projection
        if self.use_edge_features and edge_attr is not None and self.edge_proj is not None:
            e = self.edge_proj(edge_attr)
        else:
            e = None

        # Message Passing with Residual Connections
        for i in range(self.num_layers):
            if self.use_edge_features and e is not None:
                h_conv = self.convs[i](h, edge_index, e)
            else:
                h_conv = self.convs[i](h, edge_index)

            h_conv = self.batch_norms[i](h_conv)
            h_conv = self.activation(h_conv)
            h = h + h_conv  # Residual skip connection
            h = self.dropout(h)

        # Graph Readout
        if self.readout_type == "sum":
            g = global_add_pool(h, batch)
        elif self.readout_type == "mean":
            g = global_mean_pool(h, batch)
        elif self.readout_type == "attention":
            g = self.readout(h, index=batch)
        else:
            g = global_add_pool(h, batch)

        # Classification Head
        logits = self.head(g).squeeze(-1)
        return logits

    def get_graph_embedding(
        self,
        x: torch.Tensor,
        edge_index: torch.Tensor,
        edge_attr: Optional[torch.Tensor] = None,
        batch: Optional[torch.Tensor] = None
    ) -> torch.Tensor:
        """
        Extract the post-readout graph representation vector g [batch_size, hidden_dim].
        """
        if batch is None:
            batch = torch.zeros(x.size(0), dtype=torch.long, device=x.device)

        h = self.node_proj(x)
        if self.use_edge_features and edge_attr is not None and self.edge_proj is not None:
            e = self.edge_proj(edge_attr)
        else:
            e = None

        for i in range(self.num_layers):
            if self.use_edge_features and e is not None:
                h_conv = self.convs[i](h, edge_index, e)
            else:
                h_conv = self.convs[i](h, edge_index)

            h_conv = self.batch_norms[i](h_conv)
            h_conv = self.activation(h_conv)
            h = h + h_conv
            h = self.dropout(h)

        if self.readout_type == "sum":
            g = global_add_pool(h, batch)
        elif self.readout_type == "mean":
            g = global_mean_pool(h, batch)
        elif self.readout_type == "attention":
            g = self.readout(h, index=batch)
        else:
            g = global_add_pool(h, batch)

        return g

    @torch.no_grad()
    def predict_proba(
        self,
        x: torch.Tensor,
        edge_index: torch.Tensor,
        edge_attr: Optional[torch.Tensor] = None,
        batch: Optional[torch.Tensor] = None
    ) -> torch.Tensor:
        """
        Compute predicted cascade probabilities via sigmoid.
        """
        self.eval()
        logits = self.forward(x, edge_index, edge_attr, batch)
        return torch.sigmoid(logits)

